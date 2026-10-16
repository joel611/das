# Desktop e2e (WebdriverIO + embedded Tauri WebDriver)

macOS has no WKWebView driver, so `tauri-driver` does not work there. `@wdio/tauri-service` runs a WebDriver
server inside the app instead (`tauri-plugin-wdio-webdriver`), compiled in only with the `e2e` Cargo feature.

    bun run --cwd packages/desktop e2e

Builds a debug binary with `--features e2e` and `src-tauri/tauri.e2e.conf.json`, then runs `e2e/*.e2e.ts`.
`onPrepare` builds a sandbox (`fixture.ts`): temp `DAS_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, a free
`PORT` and a `TOKEN`, exported through env so the app's Rust relay and the daemon agree. Nothing touches your real
`~/.config/das` or `~/.claude`. Specs that need a daemon call `startDaemon()`; `offline.e2e.ts` does not.

Specs: shell and nav, offline state, `api` relay (token injection, path allowlist), settings round trip, window
hide-on-close, jev project picker. Specs that only need canned API data use `startMockApi(routes)` (a tiny HTTP
server on the sandbox port) instead of the real daemon. `__TAURI_INTERNALS__.invoke` is read-only, so the relay
can't be stubbed from the webview. Screenshots land in `e2e/*.png` (gitignored).
