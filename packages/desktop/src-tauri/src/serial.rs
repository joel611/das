// Reads the stack-chan's log stream (Moddable `trace()`) from its USB serial port, line by line.
// Tauri-free so it can be exercised with `cargo run --example serial_tail`.
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const ESPRESSIF_VID: u16 = 0x303A;

/// The device's USB port: an Espressif VID, else any `cu.usbmodem` name (macOS).
pub fn find_port() -> Option<String> {
    let ports = serialport::available_ports().ok()?;
    ports
        .into_iter()
        .filter(|p| {
            p.port_name.contains("cu.usbmodem")
                || matches!(&p.port_type, serialport::SerialPortType::UsbPort(u) if u.vid == ESPRESSIF_VID)
        })
        .map(|p| p.port_name)
        .min() // /dev/cu.* sorts before /dev/tty.*
}

/// Blocks, calling `on_line` per text line, until `stop` is set or the port errors (unplug).
/// DTR and RTS stay low: toggling them resets the ESP32-S3 (USB-Serial-JTAG).
pub fn read_lines(path: &str, stop: &Arc<AtomicBool>, mut on_line: impl FnMut(String)) -> Result<(), String> {
    let mut port = serialport::new(path, 115_200)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| e.to_string())?;
    port.write_data_terminal_ready(false).ok();
    port.write_request_to_send(false).ok();

    let mut buf = [0u8; 1024];
    let mut line = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        match port.read(&mut buf) {
            Ok(0) => return Err("port closed".into()),
            Ok(n) => {
                for &b in &buf[..n] {
                    if b == b'\n' {
                        on_line(String::from_utf8_lossy(&line).trim_end_matches('\r').to_string());
                        line.clear();
                    } else if line.len() < 4096 {
                        line.push(b);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
