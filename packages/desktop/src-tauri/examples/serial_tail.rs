// cargo run --example serial_tail [port]   (prints lines for 30 s)
#[path = "../src/serial.rs"]
mod serial;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn main() {
    let port = std::env::args().nth(1).or_else(serial::find_port).expect("no port found");
    eprintln!("port: {port}");
    let stop = Arc::new(AtomicBool::new(false));
    let s = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        s.store(true, Ordering::Relaxed);
    });
    let r = serial::read_lines(&port, &stop, |l| println!("{l}"));
    eprintln!("ended: {r:?}");
}
