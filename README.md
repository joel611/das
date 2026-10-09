# stack-chan-server

Run: `PROJECT_ROOTS=~/Projects bun src/server.ts` (env: `PORT`, `TOKEN`). Test: `bun test`.

## WebSocket protocol

`WS /v1/ws` (JSON text frames). Auth: `Authorization: Bearer <TOKEN>` or `?token=<TOKEN>` (only when `TOKEN` is set).

| Direction | Frame |
|---|---|
| client -> server | `{"type":"hello","device":"name","capabilities":["display"]}` |
| server -> client | `{"type":"snapshot","projects":[...],"sessions":[...],"display":D}` (reply to hello) |
| server -> client | `{"type":"delta","session":{...},"display":D}` (session changed) |
| server -> client | `{"type":"delta","removed":"<sessionId>","display":D}` (SessionEnd) |

`D = {"expression":"focused|worried|happy|sad|neutral","headline":"3 running","count":3}`.
Rollup priority: error > waiting > running > done > idle. `button` is reserved (ignored); unknown messages are ignored.

## Try it

```sh
bun scripts/mock-client.ts ws://localhost:4321/v1/ws
curl -X POST localhost:4321/hooks/UserPromptSubmit -d '{"session_id":"s1","cwd":"/tmp"}'
curl -X POST localhost:4321/hooks/Stop -d '{"session_id":"s1"}'
curl -X POST localhost:4321/hooks/SessionEnd -d '{"session_id":"s1"}'
```

## Voice router

A transcript is routed to a project by a decision model (Jev via OpenRouter, `typesafe/jev-1.13`); on a confident match the server runs `claude --bg --worktree voice-<project>-<time> --permission-mode auto -n voice-<project>-<time> "<transcript>"` from that project (or the chosen worktree). `--worktree` is always passed, so every voice session works in its own new git worktree and branch (`worktree-voice-<project>-<time>`) and never edits an existing checkout. The prompt is the transcript verbatim.

**Real spawns run in auto permission mode, so edits happen unattended, but only inside their own worktree.** Review and merge or delete the branch afterwards (`claude rm <id>` removes the session and its worktree when safe).

| Direction | Frame |
|---|---|
| client -> server | `{"type":"voice.transcript","text":"fix the login bug in stack-chan"}` |
| server -> client | `{"type":"voice.reply","status":"spawned\|ask\|escalate\|error","text":"Started in stack-chan-server","project":"...","sessionId":"..."}` |

`POST /v1/voice` with `{"text":"...","device":"name"}` returns the same JSON without the `type` field (same auth as other `/v1` routes).

Bands (by the top choice's confidence): `>= ACT_THRESHOLD` (0.8) spawn; `ASK_THRESHOLD` (0.4) to ACT ask "Which one, A or B?" and remember the question per socket (or per `device`); the next transcript is decided again with the question as context. Below ASK, or choice `none`, escalate ("Sorry, I didn't catch that"). Hard gates: project must be in the scanned list, transcript non-empty and at most 1000 chars. A missing `OPENROUTER_API_KEY` gives `status: "error"`.

Every decision is appended as a JSON line to `DECISIONS_LOG` (default `./data/decisions.jsonl`: ts, transcript, choice, confidence, probabilities, band, outcome) for threshold tuning. Env: `OPENROUTER_API_KEY`, `CLAUDE_BIN`, `ACT_THRESHOLD`, `ASK_THRESHOLD`, `DECISIONS_LOG`.

### Voice console and dry run

The menu bar app has a `Voice console…` item that opens a typed stand-in for speech: type a request, see the router's decision. The page is part of the app (`app/ui/console.html`) and calls the server through the Rust `api` command, which adds the token, so there is no token field and no server route for it. It talks to `POST /v1/voice` with device id `console` (so an "ask" can be answered on the next turn; "New conversation" switches to a fresh id), lists routable projects (`/v1/projects`), and shows whether an OpenRouter key is set and how many projects are untrusted.

**Dry run is the default** (checkbox checked). It runs the decider, bands, allowlist gates and ask bookkeeping, and logs the decision with `outcome: "dry-run"`, but never calls the spawner. Unchecking it shows a red warning, and each send needs a second click on "Yes, send for real" (an inline prompt, because native dialogs are not reliable in the webview), since a real send starts `claude --bg --permission-mode auto` in an isolated worktree.

Dev helper: `SERVER=http://127.0.0.1:4321 bun scripts/dev-ui.ts` serves `app/ui` at `http://127.0.0.1:5199/console.html` in a normal browser, with a stand-in for Tauri's `invoke("api", ...)` (same allow-list and `{status, body}` result), so the real UI files can be tested without the native window. Set `TOKEN` if the server needs one.

`POST /v1/voice` body: `{"text":"...","device":"name","dryRun":false,"debug":false}`. `dryRun` and `debug` are optional booleans. A missing `dryRun` is a REAL run (as before), so existing clients are unchanged. `dryRun: true` or `debug: true` adds a `debug` field to the reply; normal replies have none.

```json
{ "status": "dry-run", "text": "Would start in recipe-app", "project": "recipe-app",
  "debug": { "choice": "recipe-app", "confidence": 0.93, "band": "spawn",
    "probabilities": {"recipe-app": 0.93, "ml-pipeline": 0.04}, "alternatives": [{"project":"recipe-app","p":0.93}],
    "worktree": null, "cwd": "/path/recipe-app", "wouldSpawn": true, "name": "voice-recipe-app-1009-1432",
    "thresholds": {"act": 0.8, "ask": 0.4} } }
```

`status` is one of `spawned`, `dry-run` (a spawn that was skipped), `ask`, `escalate`, `error`. In a dry run, `ask` and `escalate` replies are unchanged apart from `debug`.

### Workspace trust

`claude --bg` refuses to start in a folder Claude Code does not trust ("Workspace not trusted"); there is no dialog in a background spawn. Trust is stored per folder in `~/.claude.json` (`projects[<path>].hasTrustDialogAccepted`), there is no `settings.json` key for it, and a trusted folder covers every subfolder (verified with `claude --bg`: a child of a trusted folder starts, a child of an untrusted one is refused). Trust is never saved for the home directory.

At startup the server reads `~/.claude.json` (read-only) and prints which scanned projects are not covered. Fix: run `claude` once in the root folder and accept the dialog. Trusting a root also lets the project hooks, `.mcp.json` and allow rules of every repo under it run, so pick the narrowest folder that holds only repos you trust. A refused spawn replies `status: "error"`, `text: "Claude does not trust <project> yet"`.

## App (menu bar)

A Tauri v2 menu bar app in `app/`. It runs the server as a sidecar (a `bun build --compile` binary), shows the aggregate state in the tray, and has a Settings window. No Dock icon.

```sh
bun install
bun run app:dev      # builds the sidecar, then tauri dev
bun run app:build    # builds the sidecar, then a release Stack-chan.app (app/src-tauri/target/release/bundle/macos/)
bun run sidecar:build  # only the sidecar: app/src-tauri/binaries/stack-chan-server-<triple>
```

Tray: a status line (`2 running`, `idle`, `server down`), `Settings…`, `Quit`. The icon colour follows the top state (idle, running, waiting, done, error; a ring when the server is down). The app polls `GET /v1/state` every 2 s, restarts the sidecar if it dies or if the port setting changes, and stops it on Quit (it also exits on its own if the app is killed). Sidecar output goes to `<settings dir>/server.log`. The sidecar starts through your login shell so it finds `claude` on `PATH`.

### Settings

`~/Library/Application Support/stack-chan-server/config.json` (mode 0600), or `$STACKCHAN_CONFIG_DIR/config.json`: `{roots, port, token, openrouterKey}`. Precedence: env (`PROJECT_ROOTS`, `PORT`, `TOKEN`, `OPENROUTER_API_KEY`) over the file over defaults. Token and OpenRouter key are write-only in the API (`hasToken`, `hasOpenrouterKey`). A root change rescans at once; a token change applies at once; a port change replies `restartRequired: true` and the app restarts the sidecar.

Admin API (localhost only, plus the token if set):

| Route | Result |
|---|---|
| `GET /admin/settings` | `{roots, port, hasToken, hasOpenrouterKey, envOverrides, trustAdvice}` |
| `PUT /admin/settings` | body: any of `roots` (existing dirs), `port` (1-65535), `token`, `openrouterKey` (`""` clears); returns the GET shape plus `restartRequired` |
| `GET /admin/hooks` | `{state, events:{<Event>: installed\|partial\|missing}, portMatches, port}` |
| `POST /admin/hooks/install`, `DELETE /admin/hooks` | same shape after the change |
| `GET /v1/devices` | `[{id, device, capabilities, connectedAt}]` (from `hello`) |
| `GET /v1/state` | `{display, sessions, devices, projects, untrustedProjects}` |

### Hook installer

Adds one command hook per event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`) to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). Each hook pipes the hook JSON to `http://127.0.0.1:<port>/hooks/<Event>` with `curl -s -m 2 ... >/dev/null 2>&1 || true`: no output, always exit 0, it never blocks or changes the agent.

- Additive: your existing hooks and all other keys stay. Our entry is a new matcher group (no `matcher`, so it matches all).
- Marker: every command ends with `# stack-chan-server`. Install is idempotent (re-install updates the port, no duplicates). Uninstall removes only marked entries and the groups or events it emptied.
- Safe write: the path is resolved with `realpath` (a symlinked `~/.claude` or `settings.json` stays a symlink), a `settings.json.bak-<timestamp>` copy is made before each change, and the new file is written to a temp file in the same directory and renamed onto the target. A file that is not valid JSON is refused and left alone. Nothing is written when nothing changes.

### Manual steps

1. `bun run app:build`, then open `app/src-tauri/target/release/bundle/macos/Stack-chan.app` (or run `bun run app:dev`).
2. Tray icon, `Settings…`: set the root folders, port, and OpenRouter key; Save.
3. Click `Install hooks` (check the status line says `installed`). Running Claude sessions need a restart to load hooks.
4. Run `claude` once in each root folder and accept the trust dialog, so voice spawns work. The Settings window lists untrusted projects.
