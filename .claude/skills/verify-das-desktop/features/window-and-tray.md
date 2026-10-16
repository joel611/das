# Window lifecycle and tray

## Sub-features
- Closing the dashboard window hides it; app keeps running (menu bar only, no Dock icon).
- Tray menu: status line (`2 running` / `idle` / `daemon not running`), `Open Dashboard`, `Quit`; icon colour follows top state.

## How to get to it (user POV)
Click the menu bar icon, `Open Dashboard`; red close button hides the window.

## Driving it with WDIO
- `e2e/window.e2e.ts`: `getCurrentWindow().show()` -> `isVisible()` true; `.close()` -> waits for `isVisible()` false; page still answers (`document.title` = `Stack-chan`).
- Tray: not drivable (native). Observe the state the tray renders from via `GET /v1/state` (Rust polls it every 2s, `src-tauri/src/main.rs`) and report the tray as unobserved.

## Gotchas
- Window API needs `withGlobalTauri` + the `core:window:allow-*` permissions in `src-tauri/tauri.e2e.conf.json`; production config may not expose them.
- `Quit` is not tested: it would kill the app under test.
