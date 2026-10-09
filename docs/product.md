# Product

A personal Mac server that watches my Claude Code sessions across all my projects and exposes an API so `stack-chan` (and later other LAN devices) can show status and take voice commands.

Stack: **Bun** (server/daemon) + **Tauri** (menu bar shell). Personal use, no signing/distribution concerns.

## Client

`stack-chan`: tiny desktop robot. Custom apps are JavaScript `mod`s on Moddable.
https://github.com/stack-chan/stack-chan/tree/develop/firmware/mods

Hardware is still shipping. Develop against the provided web simulator, so the protocol must work with any WebSocket client (simulator, mock script, future devices).

## Goals

1. **Ambient status** (primary): glance at the robot, know what every agent is doing.
2. **Multi-project**: one root folder, nested projects found by git detection.
3. **Voice input**: speak a task, server routes it to the right project and spawns a background Claude session.
4. **Device-agnostic API**: stack-chan first, anything on the LAN later.

Non-goals (for now): approve/deny from the robot (I run auto mode), multi-user, cloud, distribution.

## Components

```
Claude Code sessions ──hooks──▶ ┌────────────── Bun server ──────────────┐
                                │ project scanner   session tracker      │◀── Tauri menu bar UI
~/.claude/projects/*.jsonl ───▶ │ state aggregator  router agent         │
                                │ REST + WebSocket API                   │
                                └──────┬──────────────────────▲──────────┘
                                  state │                      │ transcript
                                        ▼                      │
                                  stack-chan / simulator / other devices
```

### 1. Project scanner
- Config: one or more root folders.
- Walk the tree, treat any dir with `.git` (dir **or** file, so worktrees count) as a project; stop descending at a git root.
- Watch for added/removed repos (fs watch + periodic rescan).
- Project = `{id, name, path, branch}`. Map a session `cwd` to a project by longest path prefix.

### 2. Session tracker
- Source of truth: **Claude Code hooks** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`) installed in `~/.claude/settings.json`, each posting JSON to `http://localhost:<port>/hooks/:event`. Hooks must be fire-and-forget, never block the agent.
- Backup/enrichment: tail `~/.claude/projects/<encoded-cwd>/*.jsonl` for last assistant message, tool name, timestamps.
- Session state: `idle | running | waiting | done | error`.
  - Auto mode means `waiting` is rare; mainly `running`, `done`, `error`.
- Handle background agents: sessions spawned by the server are tagged so they are not double-counted.

### 3. State aggregator
- Per-project and global rollup. Priority: `error > waiting > running > done > idle`.
- Server decides presentation, devices stay dumb: emits a `display` hint (`expression`, `headline`, `count`) alongside raw state.
- "Done" decays to idle after N minutes.

### 4. Router agent (voice)
- Device sends transcript text (STT is device/client side; server never handles audio).
- Small agent gets: transcript + project list (names, paths, recent activity). Decides `{project, prompt}` or asks for clarification.
- Spawns a background Claude session in that project (Agent SDK or `claude` CLI; verify the exact background mechanism when implementing).
- Replies to the device with a short spoken-style confirmation ("Started in stack-chan-server").
- Low confidence / ambiguous project → reply with a question instead of spawning.

### 5. API
Single port on LAN, bearer token auth.

| Endpoint | Purpose |
|---|---|
| `WS /v1/ws` | Device connection. `hello` (device id, capabilities) → server sends `snapshot`, then `delta` events. Device sends `voice.transcript`, `button`. |
| `GET /v1/projects` | Discovered projects |
| `GET /v1/sessions` | Current sessions + state |
| `POST /v1/voice` | HTTP fallback for transcript |
| `POST /hooks/:event` | Claude Code hook ingest (localhost only) |

Event shape (sketch):
```json
{ "type": "delta", "session": "abc", "project": "stack-chan-server",
  "state": "running", "detail": "Edit src/api.ts",
  "display": { "expression": "focused", "headline": "3 running" } }
```
Capabilities in `hello` (`screen`, `speaker`, `mic`, `buttons`, `servo`) let the server tailor output per device.

### 6. Tauri shell
- Menu bar icon with aggregate state color.
- Spawns Bun server as a sidecar (`bun build --compile`).
- Settings: root folders, port, token, connected devices, hook install/uninstall.

## Stack-chan mod (client side)
- Connects to server over WebSocket (mDNS/Bonjour discovery, manual host fallback).
- Maps `display.expression` to face; head turns toward desk on `done`/`error`.
- Button: cycle through projects/sessions. Hold: start voice capture.
- Multi-session view: count + current project name; cycle on button.

## Milestones

1. **Server skeleton**: scanner + hook ingest + in-memory sessions + `GET /v1/sessions`.
2. **WebSocket + mock client**: snapshot/delta protocol, tested with a mock script and the web simulator.
3. **Stack-chan mod** (simulator first): expressions by state, session cycling.
4. **Voice router**: transcript → router agent → spawn background session.
5. **Tauri shell**: menu bar, sidecar, settings, hook installer.
6. **Real hardware** when it arrives.

## Open questions
- Exact mechanism for spawning/monitoring background Claude sessions (CLI flags vs Agent SDK)?
- Router agent model/cost: Haiku-class via Agent SDK or `claude -p`?
- Does the web simulator support WebSocket + mic/transcript input, or only display?
- Should voice-spawned sessions need a robot-side confirm before running (auto mode = unattended edits)?
- Root folder structure: any monorepos where sub-packages should count as separate projects?
- Security: LAN-bound API can spawn agents, so token auth and a voice-spawn allowlist are mandatory.
