# Desktop e2e (WebdriverIO + embedded Tauri WebDriver)

macOS has no WKWebView driver, so `tauri-driver` does not work there. `@wdio/tauri-service` runs a WebDriver
server inside the app instead (`tauri-plugin-wdio-webdriver`), compiled in only with the `e2e` Cargo feature.

    bun run --cwd packages/desktop e2e

Builds a debug binary with `--features e2e` and `src-tauri/tauri.e2e.conf.json`, then runs `e2e/*.e2e.ts`.
The app talks to whatever daemon is on the configured port, so tests see real data when it is running.
Screenshots land in `e2e/*.png` (gitignored).
