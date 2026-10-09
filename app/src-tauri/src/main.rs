use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 4321;

/// The running sidecar and the port it was started for.
static SIDECAR: Mutex<Option<(Child, u16)>> = Mutex::new(None);

// ---- settings (same file and precedence as src/config.ts: env > file > default) ----

fn config_dir() -> PathBuf {
    match std::env::var("STACKCHAN_CONFIG_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support/stack-chan-server"),
    }
}

fn port_and_token() -> (u16, String) {
    let file: Value = std::fs::read_to_string(config_dir().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
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

// ---- tiny blocking HTTP/1.1 client for the local server ----

fn http(method: &str, path: &str, body: Option<&str>) -> Result<(u16, String), String> {
    let (port, token) = port_and_token();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(1)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
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

/// Called by the settings window; the Rust side adds the token, so the page never handles it.
#[tauri::command]
fn api(method: String, path: String, body: Option<String>) -> Result<Value, String> {
    if !(path.starts_with("/admin/") || path.starts_with("/v1/")) {
        return Err("path not allowed".into());
    }
    let (status, text) = http(&method, &path, body.as_deref())?;
    Ok(json!({ "status": status, "body": serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)) }))
}

// ---- sidecar ----

fn sidecar_path() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("stack-chan-server"))).unwrap_or_default()
}

fn spawn_sidecar() -> Option<Child> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).ok();
    let log = OpenOptions::new().create(true).append(true).open(dir.join("server.log")).ok()?;
    // A login shell gives the server the user's PATH (a GUI app gets a bare one), which `claude` spawns need.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    Command::new(shell)
        .args(["-l", "-c", "exec \"$0\""])
        .arg(sidecar_path())
        .env("STACKCHAN_EXIT_ON_STDIN_CLOSE", "1")
        .stdin(Stdio::piped()) // held open by us; the server exits when it closes (app killed or crashed)
        .stdout(log.try_clone().ok()?)
        .stderr(log)
        .spawn()
        .map_err(|e| eprintln!("sidecar spawn failed: {e}"))
        .ok()
}

fn stop_sidecar() {
    if let Some((mut child, _)) = SIDECAR.lock().unwrap().take() {
        child.kill().ok();
        child.wait().ok();
    }
}

/// Start the sidecar if missing or dead; restart it when the configured port changed.
fn ensure_sidecar(port: u16) {
    let mut guard = SIDECAR.lock().unwrap();
    let stale = match guard.as_mut() {
        Some((child, p)) => *p != port || child.try_wait().map(|s| s.is_some()).unwrap_or(true),
        None => true,
    };
    if stale {
        if let Some((mut child, _)) = guard.take() {
            child.kill().ok();
            child.wait().ok();
        }
        *guard = spawn_sidecar().map(|c| (c, port));
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
        return (STATES[5], "server down".into(), "Stack-chan: server down".into());
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
        let (port, _) = port_and_token();
        ensure_sidecar(port);
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

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        w.show().ok();
        w.set_focus().ok();
        return;
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Stack-chan Settings")
        .inner_size(540.0, 760.0)
        .build()
        .map_err(|e| eprintln!("settings window: {e}"))
        .ok();
}

/// Typed voice console: bundled page that calls the server through the `api` command, like Settings.
fn open_console(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("console") {
        w.show().ok();
        w.set_focus().ok();
        return;
    }
    WebviewWindowBuilder::new(app, "console", WebviewUrl::App("console.html".into()))
        .title("Stack-chan Voice Console")
        .inner_size(760.0, 720.0)
        .build()
        .map_err(|e| eprintln!("console window: {e}"))
        .ok();
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![api])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let status = MenuItem::with_id(app, "status", "starting…", false, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let console = MenuItem::with_id(app, "console", "Voice console…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &console, &settings, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(icon("offline"))
                .icon_as_template(false)
                .tooltip("Stack-chan")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "console" => open_console(app),
                    "settings" => open_settings(app),
                    "quit" => {
                        stop_sidecar();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            std::thread::spawn(move || poll_loop(handle, status));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Stack-chan")
        .run(|_app, event| match event {
            // Closing the settings window must not quit the menu bar app.
            RunEvent::ExitRequested { code, api, .. } if code.is_none() => api.prevent_exit(),
            RunEvent::Exit => stop_sidecar(),
            _ => {}
        });
}
