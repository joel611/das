# Rust `api` relay

## Sub-features
- The page calls the Tauri command `api`; Rust forwards to `127.0.0.1:<PORT>`, adds the bearer token, so the page never holds it.
- Only paths starting `/admin/` or `/v1/` are allowed; others reject with `path not allowed`.
- Port/token come from `$DAS_CONFIG_DIR/config.yml`, overridden by env `PORT`/`TOKEN`.

## How to get to it (user POV)
Invisible; every dashboard call goes through it.

## Driving it with WDIO
`e2e/relay.e2e.ts` with `startDaemon()`: direct `fetch` to `/admin/settings` without token is 401; `invoke("api", {method:"GET", path:"/admin/settings", body:null})` returns `status 200` and `body.hasToken === true`; `path: "/etc/passwd"` rejects with `path not allowed`.

## Gotchas
- Using `invoke` is the feature here, not a shortcut; for any UI feature drive the UI instead.
- Relay read timeout is 15s (voice calls a model).
