# Product

A **desktop command center**: a Tauri desktop app on top of a local Bun daemon. Its main use case is managing my Claude Code sessions across all my projects and exposing an API so external devices can show status and send commands. The first agent is Claude Code; the first device is `stack-chan`.

The command center **owns its classifier and LLM** for reasoning. It does not borrow intelligence from the agents it manages: it decides what a request is, then delegates.

Stack: **Bun** (daemon) + **Tauri** (desktop shell, tray, dashboard). Personal use, no signing/distribution concerns.

## Vision

```
request (voice / text / device event)
        │
        ▼
 ┌─────────────── command center ───────────────┐
 │ classifier + LLM: what is the user's intent? │
 └───┬───────────────┬───────────────┬──────────┘
     ▼               ▼               ▼
 coding agent    home / IoT      MCP tools /
 (Claude Code    (Home Assistant) other workflows
  now; others
  later)
```

1. **Now**: Claude Code session management (watch, spawn) plus stack-chan as the device.
2. **Next**: more coding agents for coding tasks behind the same delegate interface.
3. **Later**: non-coding tasks, e.g. Home Assistant and MCP servers, as agents or workflows the classifier can delegate to.

The classifier first determines the user's intent (which agent or workflow, then which project or target), then delegates. Everything downstream is a pluggable "agent" or "workflow" behind one interface.

## Devices

- **stack-chan** is the only device with first-party support (a MOD client in this repo). Custom apps are JavaScript `mod`s on Moddable: https://github.com/stack-chan/stack-chan/tree/develop/firmware/mods
- **Any IoT device** that speaks HTTP and WebSocket can connect to the same API. No device-specific code in the daemon: devices declare `capabilities` in `hello` and the server tailors output.
- Develop against the web simulator, so the protocol must work with any WebSocket client (simulator, mock script, real devices).

## Goals

1. **Command center for coding agents** (primary): one place to see and start Claude Code sessions across projects.
2. **Ambient status**: glance at the robot, know what every agent is doing.
3. **Multi-project**: one root folder, nested projects found by git detection.
4. **Intent classification and delegation**: a request is classified, then routed to the right agent/workflow. Today: choose a project and spawn a background Claude session.
5. **Device-agnostic API**: stack-chan first, any HTTP/WebSocket device after.
6. **Extensible**: other coding agents, Home Assistant, MCP (planned, not built).

Non-goals (for now): approve/deny from the robot (I run auto mode), multi-user, cloud, distribution, first-party support for devices other than stack-chan.

## Components

```
Claude Code sessions ──hooks──▶ ┌───────── Bun daemon (command center) ──┐
                                │ project scanner   session tracker      │◀── Tauri desktop UI
~/.claude/projects/*.jsonl ───▶ │ state aggregator  classifier / router  │
                                │ REST + WebSocket API                   │
                                └──────┬──────────────────────▲──────────┘
                                  state │                      │ transcript
                                        ▼                      │
                                  stack-chan / simulator / other devices
```

### 1. Project scanner
- Config: one or more root folders.
- Walk the tree, find every dir with `.git` (dir **or** file); stop descending at a git root.
- **Group worktrees into one project.** Resolve each `.git` to its git common dir (`git rev-parse --git-common-dir`); all checkouts sharing a common dir are one project. Main checkout = primary, others come from `git worktree list --porcelain`.
  - Includes sibling worktree folders (e.g. `repo-feature/`) and nested ones (e.g. `repo/.claude/worktrees/x`). Never list a nested worktree as its own project.
  - Linked worktrees outside the root folder still attach to their project.
- Watch for added/removed repos and worktrees (fs watch + periodic rescan).
- Project = `{id, name, path, worktrees: [{path, branch}]}`.
- Map a session `cwd` to a worktree by longest path prefix, then roll up to its project. Device UI shows project, with branch/worktree as detail.

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

### 4. Classifier / router (command center brain)
- Owns the classifier and LLM. Today it handles one intent, "start a coding task in a project"; the design is intent-first so new intents (other coding agents, Home Assistant, MCP) plug in as delegates later.
- Pipeline: transcript → intent classification → delegate (agent/workflow) → target selection → action. The project routing below is the Claude Code delegate.
- Device sends transcript text (STT is device/client side; server never handles audio).
- Small agent gets: transcript + project list (names, paths, worktrees, recent activity). Returns structured output: `{project, worktree?, prompt, confidence, alternatives[]}`.
- **Confidence-gated decision, modeled on [Jev](https://techjacksolutions.com/ai-tools/typesafe/what-is-jev-typesafe-ai/)** (TypeSafe AI decision model: takes text state + typed questions, returns choices/scores with a 0-1 confidence; it decides, it does not generate text):
  - Project selection = a Jev-style `Choice` question over the project list. The task prompt is the transcript passed through, so no generation step is needed.
  - Confidence bands (act / ask / escalate):
    - `>= act` → spawn immediately, no question.
    - between `ask` and `act` → reply with a question naming the top candidates; the next transcript resolves it.
    - `< ask` → don't spawn, tell the user it didn't understand.
  - Thresholds come from labeled data and the cost of a wrong spawn, not a guess. Log every decision (transcript, choice, confidence, outcome), then tune per band. Start conservative.
  - Spawning is hard to undo, so confidence is one gate among others (e.g. project-name match, allowlist).
  - **Connection: [OpenRouter](https://openrouter.ai/docs/guides/community/jev).** Model `typesafe/jev-1.13` (or alias `~typesafe/jev-latest`), billed to my OpenRouter key. Output tokens are free, input billed per token; 32k context. Via the TypeSafe SDK pointed at OpenRouter (`/api/v1/systemone`) or the raw Decisions API (`POST /api/alpha/decisions`); pick at M4 after checking which is current.
  - Jev returns typed answers only (no free text), so it only does the routing decision. Fallback if needed: a Haiku-class chat model via OpenRouter `chat/completions` with structured output. Keep it behind one `decide()` interface so it can be swapped.
  - `OPENROUTER_API_KEY` lives in server config/env, never in git.
- Spawns a background Claude session via **`claude` CLI flags** (no Agent SDK for spawning) with `cwd` set to the chosen worktree. Exact flags are pinned when implementing M4.
- Router model: **TBC**. Candidates are Haiku-class for cost/latency; benchmark on real transcripts before choosing.
- Replies to the device with a short spoken-style confirmation ("Started in stack-chan-server").

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

### 6. Tauri desktop shell
- Menu bar icon with aggregate state color; dashboard window for sessions, projects, devices, console and settings.
- The daemon runs independently (`bun run daemon --bg`); the desktop app shows its status and talks to it over the API. Sidecar bundling is a later option.
- Settings: root folders, port, token, connected devices, hook install/uninstall.

## Stack-chan mod (reference device client)
- Connects to server over WebSocket (mDNS/Bonjour discovery, manual host fallback).
- Maps `display.expression` to face; head turns toward desk on `done`/`error`.
- Button: cycle through projects/sessions. Hold: start voice capture.
- Multi-session view: count + current project name; cycle on button.

## Milestones

1. **Server skeleton**: scanner + hook ingest + in-memory sessions + `GET /v1/sessions`.
2. **WebSocket + mock client**: snapshot/delta protocol, tested with a mock script and the web simulator.
3. **Stack-chan mod** (simulator first): expressions by state, session cycling.
4. **Voice router**: transcript → router agent → spawn background session.
5. **Desktop app**: menu bar, dashboard, settings, hook installer.
6. **Real hardware** when it arrives.
7. **Intent classifier + delegate interface**: classify before routing; Claude Code becomes one delegate.
8. **More delegates**: other coding agents, then Home Assistant and MCP.

## Open questions
- Delegate interface: what does an agent/workflow declare (intents it handles, inputs, how progress is reported back to devices)?
- Intent taxonomy: how many intents before a dedicated classifier beats one routing prompt?
- Home Assistant / MCP: act through MCP tools directly, or via Home Assistant's own API? What allowlist guards actions?
- Generic device onboarding: how does an unknown HTTP/WebSocket device declare capabilities and get a token?
- Which exact `claude` CLI flags for background spawn and monitoring? Check `claude --help` at M4.
- Router agent model: TBC, benchmark Haiku-class vs others.
- Jev (TypeSafe AI) via OpenRouter: confirmed available. Remaining: which endpoint is current (`/api/alpha/decisions` vs `/api/v1/systemone`), exact input pricing, latency for a voice round trip, and the calibration claim (vendor-stated, validate on my own transcripts).
- Does the web simulator support WebSocket + mic/transcript input, or only display?
- Confidence calibration: LLM self-reported confidence is weak. Consider blending with deterministic signals (exact project-name match, recent activity in that project).
- Root folder structure: any monorepos where sub-packages should count as separate projects?
- Security: LAN-bound API can spawn agents, so token auth and a voice-spawn allowlist are mandatory.
