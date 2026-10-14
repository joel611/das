# @stackchan/desktop: menu bar app and dashboard

A Tauri v2 app (scaffolded with [tauri-ui](https://github.com/agmmnn/tauri-ui)): `src-tauri` is the Rust shell, `src` is a Vite+ React app with Tailwind v4 and shadcn/ui (base-nova).

It does not run the daemon. Start that yourself (`bun run daemon --bg`); the app shows "daemon not running" until it is up.

```sh
bun run desktop                          # from the repo root: tauri dev (Vite+ dev server + the Rust app)
cd packages/desktop && bun run tauri build   # release Stack-chan.app in src-tauri/target/release/bundle/macos/
```

## Tray

macOS menu bar only (no Dock icon). Menu: a status line (`2 running`, `idle`, `daemon not running`), `Open Dashboard`, `Quit`. The icon colour follows the top state (idle, running, waiting, done, error; a ring when the daemon is down). The app polls `GET /v1/state` every 2 seconds. Closing the dashboard window hides it; the app keeps running.

## Dashboard

The app uses a dark cyberpunk theme (Chakra Petch and JetBrains Mono, bundled; neon cyan and magenta on a dark grid). Press `d` to switch to light mode.

- **Command** (default): the command center. Left: running agents (most urgent first; click one) and the skills that agent has triggered. Centre: Jev, the voice router, with an orb, the conversation and a command box at the bottom. It uses the same `POST /v1/voice` as the Console, dry run on by default, and a real send needs a second click. Right: token usage for the current 5-hour block (time to reset, tokens, cache reads, burn rate over the last hour), then tokens by agent and by model. Plan limits are shown as not reported.
- **Overview**: status, session, device and project counts; live sessions (most urgent first); projects with their session states; connected devices.
- **Console**: a typed stand-in for speech. Type a request and see the router's decision. **Dry run is on by default**: the router decides but nothing starts, and the reply shows the choice, confidence, band, probability bars, thresholds and the folder it would use. Unchecking it shows a red warning, and each real send needs a second click on "Yes, send for real" (a real send starts a Claude session in auto mode in an isolated worktree). "New conversation" starts a fresh device id; an "ask" is answered by the next message.
- **Settings**: root folders, port, token and OpenRouter key (write-only fields), the trust advice for untrusted projects, and hook install/uninstall (a backup of `settings.json` is made before each change).

## How it talks to the daemon

The page calls `api` (`src/lib/api.ts`). Inside the Tauri window that is the Rust `api` command, which relays to the daemon on `127.0.0.1:<port>` and adds the token, so the page never handles it. Only `/v1/*` and `/admin/*` paths are allowed. The port and token come from the same settings file the daemon uses (`$STACKCHAN_CONFIG_DIR` or `~/Library/Application Support/stack-chan-server/config.json`, with env `PORT`/`TOKEN` overriding).

## Developing the UI in a browser

```sh
cd packages/desktop
DAEMON_URL=http://127.0.0.1:5777 TOKEN=<token if set> bun run dev   # http://localhost:3000
```

Outside Tauri the same calls go through a `/daemon/*` proxy in `vite.config.ts` to the daemon. Use a throwaway `STACKCHAN_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` for the daemon when you click around, so "Install hooks" cannot touch your real Claude settings.

The CSP in `tauri.conf.json` is `default-src 'self'` plus inline styles and the IPC origin; if the native window ever shows blank, check it first.
