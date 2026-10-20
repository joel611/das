// Menu bar app. It does not own the daemon (`bun run daemon --bg`): it shows the daemon's status in the tray,
// opens the dashboard window, and relays the dashboard's calls to the daemon through the `api` command.
mod serial;

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const DEFAULT_PORT: u16 = 5777;

// ---- settings (same file and precedence as the daemon: env > file > default). Read-only: only the daemon writes config.yml. ----

fn config_dir() -> PathBuf {
    match std::env::var("DAS_CONFIG_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/das"),
    }
}

fn port_and_token() -> (u16, String) {
    let file: Value = std::fs::read_to_string(config_dir().join("config.yml"))
        .ok()
        .and_then(|s| serde_yaml::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .or_else(|| file["port"].as_u64().map(|p| p as u16))
        .unwrap_or(DEFAULT_PORT);
    let token = std::env::var("TOKEN")
        .ok()
        .or_else(|| file["token"].as_str().map(String::from))
        .unwrap_or_default();
    (port, token)
}

// ---- tiny blocking HTTP/1.1 client for the local daemon ----

fn http(method: &str, path: &str, body: Option<&str>) -> Result<(u16, String), String> {
    let (port, token) = port_and_token();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(1)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(15))).ok(); // voice requests call a model, so allow for it
    s.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let body = body.unwrap_or("");
    let auth = if token.is_empty() { String::new() } else { format!("Authorization: Bearer {token}\r\n") };
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let (head, rest) = text.split_once("\r\n\r\n").ok_or("bad response")?;
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or("bad status line")?;
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(rest) } else { rest.to_string() };
    Ok((status, body))
}

fn dechunk(mut s: &str) -> String {
    let mut out = String::new();
    while let Some((len, rest)) = s.split_once("\r\n") {
        let n = usize::from_str_radix(len.trim(), 16).unwrap_or(0);
        if n == 0 || rest.len() < n {
            break;
        }
        out.push_str(&rest[..n]);
        s = rest.get(n + 2..).unwrap_or("");
    }
    out
}

/// Called by the dashboard; the Rust side adds the token, so the page never handles it.
#[tauri::command]
fn api(method: String, path: String, body: Option<String>) -> Result<Value, String> {
    if !(path.starts_with("/admin/") || path.starts_with("/v1/")) {
        return Err("path not allowed".into());
    }
    let (status, text) = http(&method, &path, body.as_deref())?;
    Ok(json!({ "status": status, "body": serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)) }))
}

// ---- camera stream ----
// The daemon pushes frames as SSE (`/v1/devices/:id/camera/stream`). This thread holds that connection open
// (adding the token, like `api`) and re-emits each frame as a `camera-frame` event, so the page never polls.

#[derive(Default)]
struct Camera(Mutex<Option<Arc<AtomicBool>>>);

/// Feed raw (chunked) HTTP body bytes in; complete SSE `data:` payloads come out.
#[derive(Default)]
struct SseChunks {
    raw: Vec<u8>,
    text: String,
}

impl SseChunks {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.raw.extend_from_slice(bytes);
        loop {
            let Some(nl) = self.raw.windows(2).position(|w| w == b"\r\n") else { break };
            let n = usize::from_str_radix(String::from_utf8_lossy(&self.raw[..nl]).trim(), 16).unwrap_or(0);
            if self.raw.len() < nl + 2 + n + 2 {
                break;
            }
            self.text.push_str(&String::from_utf8_lossy(&self.raw[nl + 2..nl + 2 + n]));
            self.raw.drain(..nl + 2 + n + 2);
        }
        let mut out = Vec::new();
        while let Some((event, rest)) = self.text.split_once("\n\n") {
            if let Some(d) = event.lines().find_map(|l| l.strip_prefix("data:")) {
                out.push(d.trim().to_string());
            }
            self.text = rest.to_string();
        }
        out
    }
}

fn stream_camera(app: &AppHandle, id: &str, stop: &AtomicBool) -> Result<(), String> {
    let (port, token) = port_and_token();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(1)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_millis(500))).ok(); // wake up to check `stop`
    let auth = if token.is_empty() { String::new() } else { format!("Authorization: Bearer {token}\r\n") };
    let req = format!(
        "GET /v1/devices/{id}/camera/stream HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: text/event-stream\r\n{auth}\r\n"
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let (mut head, mut sse, mut buf) = (Vec::new(), SseChunks::default(), [0u8; 16384]);
    let mut in_body = false;
    while !stop.load(Ordering::Relaxed) {
        let n = match s.read(&mut buf) {
            Ok(0) => return Err("stream closed".into()),
            Ok(n) => n,
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let mut chunk = &buf[..n];
        if !in_body {
            head.extend_from_slice(chunk);
            let Some(end) = head.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
            let status = String::from_utf8_lossy(&head[..end]).split_whitespace().nth(1).map(String::from);
            if status.as_deref() != Some("200") {
                return Err(format!("camera stream: HTTP {}", status.unwrap_or_default()));
            }
            in_body = true;
            let body = head.split_off(end + 4);
            for d in sse.push(&body) {
                emit_frame(app, &d);
            }
            chunk = &[];
        }
        for d in sse.push(chunk) {
            emit_frame(app, &d);
        }
    }
    Ok(())
}

fn emit_frame(app: &AppHandle, data: &str) {
    if let Ok(v) = serde_json::from_str::<Value>(data) {
        app.emit("camera-frame", v).ok();
    }
}

#[tauri::command]
fn camera_start(app: AppHandle, state: State<Camera>, id: String) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad device id".into());
    }
    let mut slot = state.0.lock().unwrap();
    if let Some(old) = slot.take() {
        old.store(true, Ordering::Relaxed);
    }
    let stop = Arc::new(AtomicBool::new(false));
    *slot = Some(stop.clone());
    std::thread::spawn(move || {
        if let Err(e) = stream_camera(&app, &id, &stop) {
            if !stop.load(Ordering::Relaxed) {
                app.emit("camera-error", e).ok();
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn camera_stop(state: State<Camera>) {
    if let Some(stop) = state.0.lock().unwrap().take() {
        stop.store(true, Ordering::Relaxed);
    }
}

// ---- device serial console (prototype) ----
// Streams the device's USB serial log to the dashboard as `device-log` / `device-status` events.
// Only one reader runs at a time; stop it before flashing (`mod:install`), which needs the port.

#[derive(Default)]
struct Serial(Mutex<Option<Arc<AtomicBool>>>);

#[tauri::command]
fn serial_start(app: AppHandle, state: State<Serial>) -> Result<(), String> {
    let mut slot = state.0.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    *slot = Some(stop.clone());
    std::thread::spawn(move || {
        // Reconnect after unplug / device reset until stopped.
        while !stop.load(Ordering::Relaxed) {
            match serial::find_port() {
                None => {
                    app.emit("device-status", "no device").ok();
                    std::thread::sleep(Duration::from_secs(1));
                }
                Some(path) => {
                    app.emit("device-status", format!("connected {path}")).ok();
                    let r = serial::read_lines(&path, &stop, |line| {
                        app.emit("device-log", line).ok();
                    });
                    if let Err(e) = r {
                        app.emit("device-status", format!("disconnected: {e}")).ok();
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            }
        }
        app.emit("device-status", "stopped").ok();
    });
    Ok(())
}

#[tauri::command]
fn serial_stop(state: State<Serial>) {
    if let Some(stop) = state.0.lock().unwrap().take() {
        stop.store(true, Ordering::Relaxed);
    }
}

// ---- tray ----

const STATES: [&str; 6] = ["idle", "running", "waiting", "done", "error", "offline"];

fn icon(state: &str) -> Image<'static> {
    let bytes: &[u8] = match state {
        "running" => include_bytes!("../icons/tray-running.png"),
        "waiting" => include_bytes!("../icons/tray-waiting.png"),
        "done" => include_bytes!("../icons/tray-done.png"),
        "error" => include_bytes!("../icons/tray-error.png"),
        "offline" => include_bytes!("../icons/tray-offline.png"),
        _ => include_bytes!("../icons/tray-idle.png"),
    };
    Image::from_bytes(bytes).expect("tray icon").to_owned()
}

/// (state, status line, tooltip) from a /v1/state body, or the offline triple.
fn summarize(state: Option<Value>) -> (&'static str, String, String) {
    let Some(v) = state else {
        return (STATES[5], "daemon not running".into(), "Stack-chan: daemon not running (bun run daemon --bg)".into());
    };
    let st = match v["display"]["expression"].as_str() {
        Some("focused") => "running",
        Some("worried") => "waiting",
        Some("happy") => "done",
        Some("sad") => "error",
        _ => "idle",
    };
    let headline = v["display"]["headline"].as_str().unwrap_or("idle").to_string();
    let mut tip = format!("Stack-chan: {headline}, {} device(s)", v["devices"].as_u64().unwrap_or(0));
    if let Some(n) = v["untrustedProjects"].as_u64().filter(|n| *n > 0) {
        tip.push_str(&format!(", {n} untrusted project(s)"));
    }
    (st, headline, tip)
}

fn poll_loop(app: AppHandle, status: MenuItem<tauri::Wry>) {
    let mut last = String::new();
    loop {
        let state = http("GET", "/v1/state", None)
            .ok()
            .filter(|(code, _)| *code == 200)
            .and_then(|(_, body)| serde_json::from_str::<Value>(&body).ok());
        let (st, line, tip) = summarize(state);
        let key = format!("{st}|{line}|{tip}");
        if key != last {
            last = key;
            status.set_text(&line).ok();
            if let Some(tray) = app.tray_by_id("main") {
                tray.set_icon(Some(icon(st))).ok();
                tray.set_tooltip(Some(&tip)).ok();
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn open_dashboard(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        w.show().ok();
        w.unminimize().ok();
        w.set_focus().ok();
    }
}

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio::init()).plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .manage(Serial::default())
        .manage(Camera::default())
        .invoke_handler(tauri::generate_handler![api, serial_start, serial_stop, camera_start, camera_stop])
        // Closing the dashboard hides it; the menu bar app keeps running.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.hide().ok();
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let status = MenuItem::with_id(app, "status", "starting…", false, None::<&str>)?;
            let dashboard = MenuItem::with_id(app, "dashboard", "Open Dashboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &dashboard, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(icon("offline"))
                .icon_as_template(false)
                .tooltip("Stack-chan")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "dashboard" => open_dashboard(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            std::thread::spawn(move || poll_loop(handle, status));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Stack-chan")
        .run(|_app, event| {
            // Closing the dashboard must not quit the menu bar app.
            if let RunEvent::ExitRequested { code, api, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::SseChunks;

    #[test]
    fn sse_chunks_reassemble_events_split_across_chunks() {
        let mut p = SseChunks::default();
        assert!(p.push(b"8\r\ndata: {\"\r\n").is_empty());
        assert_eq!(p.push(b"7\r\na\":1}\n\n\r\n"), vec!["{\"a\":1}".to_string()]);
    }
}
