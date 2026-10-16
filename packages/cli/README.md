# @stackchan/cli: the daemon

```sh
bun run daemon            # foreground (from the repo root)
bun run daemon --bg       # detached; output and pid in the settings dir
bun run daemon --reload   # re-read config.yml in the running daemon (SIGHUP)
bun run daemon --status   # running (pid, port), config and log paths; or "not running" (exit 1)
bun run daemon --stop
bun run test              # bun tests for this package
```

Settings dir: `~/.config/das/` (or `$DAS_CONFIG_DIR`) holds `config.yml`, `daemon.pid`, `daemon.log` and `logs/`.

The daemon does not need the desktop app. The desktop app does not own the daemon: it shows its status and talks to it over the API below.

## Settings

`config.yml` (YAML, mode 0600): keys `roots`, `port`, `token`, `openrouterKey`, `usageApi` (opt-in plan limit poll, default `false`), `notificationSound` (Stack-chan beeps, default `false`). Precedence: env (`PROJECT_ROOTS`, `PORT`, `TOKEN`, `OPENROUTER_API_KEY`, `DAS_USAGE_API=1|0`) over the file over defaults. Token and OpenRouter key are write-only in the API (`hasToken`, `hasOpenrouterKey`). A root change rescans at once; a token change applies at once; a port change replies `restartRequired: true` and needs `daemon --stop` then `--bg`.

A missing `config.yml` means defaults. A `config.yml` that exists but is malformed stops startup with an error that names the file. The old `config.json` is ignored. Saving settings from the dashboard rewrites `config.yml` and drops any comments in it.

`daemon --reload` re-reads `config.yml` without a restart. Roots rescan and the token applies at once. A port change logs "restart required" and the daemon keeps the old port. A malformed file keeps the previous config and logs the error.

## Logs

| File                        | Content                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `<config dir>/logs/api.log` | One JSON line per HTTP request (including `/hooks/*`): `method`, `path`, `status`, `ms`    |
| `<config dir>/logs/ws.log`  | WebSocket upgrade accept/reject, open, close, hello (device name), frame `type` in and out |
| `<config dir>/daemon.log`   | Raw stdout/stderr of the `--bg` process (crashes before the loggers start)                 |

`api.log` and `ws.log` are JSON lines (pino, ISO `time`, no pid/hostname). They never hold payloads, the `Authorization` header or the `token` query parameter. Files rotate daily or at 10 MB, 7 are kept (pino-roll, under `logs/api/` and `logs/ws/`); `logs/api.log` and `logs/ws.log` always point at the current file, so `tail -f` survives rotation. A failing log write never affects a request.

## WebSocket protocol

`WS /v1/ws` (JSON text frames). Auth: `Authorization: Bearer <TOKEN>` or `?token=<TOKEN>` (only when `TOKEN` is set).

| Direction        | Frame                                                                                |
| ---------------- | ------------------------------------------------------------------------------------ |
| client -> server | `{"type":"hello","device":"name","capabilities":["display"]}`                        |
| server -> client | `{"type":"snapshot","projects":[...],"sessions":[...],"display":D}` (reply to hello) |
| server -> client | `{"type":"delta","session":{...},"display":D}` (session changed)                     |
| server -> client | `{"type":"delta","removed":"<sessionId>","display":D}` (SessionEnd)                  |

`D = {"expression":"focused|worried|happy|sad|neutral","headline":"3 running","count":3,"light":{"mode":"rainbow"}}`

`light` is `{"mode":"rainbow"}`, `{"mode":"solid","rgb":[r,g,b]}` or `{"mode":"blink","rgb":[r,g,b],"periodMs":1000}`. Running → rainbow, waiting → solid orange, done → solid green, error → solid red, idle → white blink..
Rollup priority: error > waiting > running > done > idle. `button` is reserved (ignored); unknown messages are ignored.

Try it:

```sh
bun packages/cli/scripts/mock-client.ts ws://localhost:5777/v1/ws
curl -X POST localhost:5777/hooks/UserPromptSubmit -d '{"session_id":"s1","cwd":"/tmp"}'
curl -X POST localhost:5777/hooks/Stop -d '{"session_id":"s1"}'
curl -X POST localhost:5777/hooks/SessionEnd -d '{"session_id":"s1"}'
```

A session's folder is matched to a project by longest path prefix; a folder reached through a symlink is matched by its resolved path.

## Voice router

A transcript is routed to a project by a decision model (Jev via OpenRouter, `typesafe/jev-1.13`); on a confident match the daemon runs `claude --bg --worktree voice-<project>-<time> --permission-mode auto -n voice-<project>-<time> "<transcript>"` from that project (or the chosen worktree). `--worktree` is always passed, so every voice session works in its own new git worktree and branch (`worktree-voice-<project>-<time>`) and never edits an existing checkout. The prompt is the transcript verbatim.

**Real spawns run in auto permission mode, so edits happen unattended, but only inside their own worktree.** Review and merge or delete the branch afterwards (`claude rm <id>` removes the session and its worktree when safe).

| Direction        | Frame                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| client -> server | `{"type":"voice.transcript","text":"fix the login bug in stack-chan"}`                                                                             |
| server -> client | `{"type":"voice.reply","status":"spawned\|dry-run\|ask\|escalate\|error","text":"Started in stack-chan-server","project":"...","sessionId":"..."}` |

`POST /v1/voice` with `{"text":"...","device":"name"}` returns the same JSON without the `type` field (same auth as other `/v1` routes).

Bands (by the top choice's confidence): `>= ACT_THRESHOLD` (0.8) spawn; `ASK_THRESHOLD` (0.4) to ACT ask "Which one, A or B?" and remember the question per socket (or per `device`); the next transcript is decided again with the question as context. Below ASK, or choice `none`, escalate ("Sorry, I didn't catch that"). Hard gates: project must be in the scanned list, transcript non-empty and at most 1000 chars. A missing `OPENROUTER_API_KEY` gives `status: "error"`.

Every decision is appended as a JSON line to `DECISIONS_LOG` (default `./data/decisions.jsonl`: ts, transcript, choice, confidence, probabilities, band, outcome) for threshold tuning. Env: `OPENROUTER_API_KEY`, `CLAUDE_BIN`, `ACT_THRESHOLD`, `ASK_THRESHOLD`, `DECISIONS_LOG`.

### Dry run

`POST /v1/voice` body: `{"text":"...","device":"name","dryRun":false,"debug":false}`. `dryRun` and `debug` are optional booleans. A missing `dryRun` is a REAL run, so existing clients are unchanged. `dryRun: true` runs the decider, bands, gates and ask bookkeeping and logs `outcome: "dry-run"`, but never calls the spawner. `dryRun: true` or `debug: true` adds a `debug` field to the reply; normal replies have none. The desktop Console tab uses dry run by default.

```json
{
  "status": "dry-run",
  "text": "Would start in recipe-app",
  "project": "recipe-app",
  "debug": {
    "choice": "recipe-app",
    "confidence": 0.93,
    "band": "spawn",
    "probabilities": { "recipe-app": 0.93, "ml-pipeline": 0.04 },
    "alternatives": [{ "project": "recipe-app", "p": 0.93 }],
    "worktree": null,
    "cwd": "/path/recipe-app",
    "wouldSpawn": true,
    "name": "voice-recipe-app-1009-1432",
    "thresholds": { "act": 0.8, "ask": 0.4 }
  }
}
```

`status` is one of `spawned`, `dry-run` (a spawn that was skipped), `ask`, `escalate`, `error`.

## Workspace trust

`claude --bg` refuses to start in a folder Claude Code does not trust ("Workspace not trusted"); there is no dialog in a background spawn. Trust is stored per folder in `~/.claude.json` (`projects[<path>].hasTrustDialogAccepted`), there is no `settings.json` key for it, and a trusted folder covers every subfolder (verified with `claude --bg`). Trust is never saved for the home directory.

At startup the daemon reads `~/.claude.json` (read-only) and prints which scanned projects are not covered. Fix: run `claude` once in the root folder and accept the dialog. Trusting a root also lets the project hooks, `.mcp.json` and allow rules of every repo under it run, so pick the narrowest folder that holds only repos you trust. A refused spawn replies `status: "error"`, `text: "Claude does not trust <project> yet"`.

## Admin and state API

Admin routes are localhost only, plus the token if set.

| Route                                              | Result                                                                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/settings`                              | `{roots, port, hasToken, hasOpenrouterKey, envOverrides, trustAdvice}`                                                                                                                                            |
| `PUT /admin/settings`                              | body: any of `roots` (existing dirs), `port` (1-65535), `token`, `openrouterKey` (`""` clears), `usageApi` (boolean), `notificationSound` (boolean); returns the GET shape plus `restartRequired`                                                |
| `GET /admin/hooks`                                 | `{state, events:{<Event>: installed\|partial\|missing}, portMatches, port}`                                                                                                                                       |
| `POST /admin/hooks/install`, `DELETE /admin/hooks` | same shape after the change                                                                                                                                                                                       |
| `GET /v1/projects`, `GET /v1/sessions`             | scanned projects (worktrees grouped), tracked sessions; each session has `skills: [{name, count, lastAt}]`                                                                                                        |
| `GET /v1/usage`                                    | `{block, limits}`: tokens in the current 5-hour block read from session transcripts; `limits`: `{fiveHour, sevenDay, updatedAt, source}` plan limits, each window `{usedPercent, resetsAt}` or `null` (see below) |
| `GET /v1/devices`                                  | `[{id, device, capabilities, connectedAt}]` (from `hello`)                                                                                                                                                        |
| `GET /v1/state`                                    | `{display, sessions, devices, projects, untrustedProjects}`                                                                                                                                                       |

Skills are counted from `PreToolUse` with `tool_name: "Skill"` (`tool_input.skill`). Typed `/name` prompts are not counted: only a Skill tool call is a trigger. Usage reads each session's `transcript_path` incrementally after the hook is answered: assistant messages are deduped by message id, `tokens` is input + output + cache writes (cache reads are reported separately), and a block starts at the hour of its first message and lasts 5 hours (the same rule as ccusage). At startup the daemon also reads the `<claude dir>/projects/<project>/<session>.jsonl` files touched in the last 5 hours, so sessions that were already running count before their next hook. Burn rate and the 12-bucket series cover the active block only.

## Plan limits

The percent of the 5-hour and weekly allowance used is not in hooks or transcripts, so the transcript block above is only an estimate. The real numbers (the ones `/usage` shows) come from two places. Both report the same account-wide windows, so within one window (same reset time) the percent only goes up: an older reading never lowers it, and a later reset time starts a new window. A window whose reset time has passed is `null` until the next report. Each window carries `observedAt` and `source` (when and from where it was last raised or replaced; a repeat of the same value doesn't count), and the dashboard shows the age past 30 minutes.

- **Claude desktop app file** (always on, read-only, no network). The Claude app checks the plan limits itself every few minutes while its menu bar icon is on and keeps them in `~/Library/Application Support/Claude/plan-usage-history.json`. The daemon looks at that file once a minute and takes its newest reading (`fh` = 5-hour, `sd` = weekly; file versions 1 and 2 only, 4 MB cap, readings older than 30 minutes ignored, readings of another organization than Claude Code's `oauthAccount.organizationUuid` ignored). The file has percentages only: the reset time is borrowed from a window the usage API already reported, otherwise the window has `resetsAt: null` and the dashboard says "Reset time unknown". A window we hold with a newer reading is never overwritten by it, and any exact reset time replaces a null one. The file format is the app's own and may change; an unknown version is skipped.
- **Usage API** (opt-in, `usageApi: true`). The daemon polls `GET https://api.anthropic.com/api/oauth/usage` (header `anthropic-beta: oauth-2025-04-20`), the endpoint behind Claude Code's `/usage`, with your Claude Code login token: `$CLAUDE_CODE_OAUTH_TOKEN`, else the macOS Keychain item `Claude Code-credentials`, else `<claude dir>/.credentials.json`. It reads `five_hour` / `seven_day` (`utilization` 0-100, ISO `resets_at`) or a `limits` array (`session`, `weekly_all`). The token is never refreshed or written: an expired one is skipped until Claude Code refreshes it, and only a running Claude Code does, so hours after the last session this finds nothing (logged once). Keychain reads time out after 5 seconds and are cached until the token expires. For a config dir other than `~/.claude` only its own scoped Keychain item is used. An idle account (`utilization` 0, `resets_at` null) shows as 0% with no reset time. The endpoint is undocumented and rate limited, so errors back off (doubling up to an hour, or `retry-after`), and it may stop working. It also counts usage from claude.ai and other machines, which the status line only sees once a local session makes a request.

## Hook installer

Adds one command hook per event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`) to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). Each hook pipes the hook JSON to `http://127.0.0.1:<port>/hooks/<Event>` with `curl -s -m 2 ... >/dev/null 2>&1 || true`: no output, always exit 0, it never blocks or changes the agent.

- Additive: your existing hooks and all other keys stay. Our entry is a new matcher group (no `matcher`, so it matches all).
- Marker: every command ends with `# stack-chan-server`. Install is idempotent (re-install updates the port, no duplicates). Uninstall removes only marked entries and the groups or events it emptied.
- Status line: earlier versions also set `statusLine` to `statusline.sh`. Install and uninstall now remove that entry and put back the command it wrapped (`DAS_WRAP_B64`), if any.
- Safe write: the path is resolved with `realpath` (a symlinked `~/.claude` or `settings.json` stays a symlink), a `settings.json.bak-<timestamp>` copy is made before each change, and the new file is written to a temp file in the same directory and renamed onto the target. A file that is not valid JSON is refused and left alone. Nothing is written when nothing changes.

### oh-my-pi (omp)

`POST /admin/omp/install` writes `<omp agent dir>/extensions/das-session.ts` (`~/.omp/agent`, or `$PI_CODING_AGENT_DIR`); `DELETE /admin/omp` removes it; `GET /admin/omp` returns `{state: installed|missing, portMatches, port}`. The Claude hook endpoints do not touch omp. The extension maps omp events onto the same `/hooks/<Event>` endpoint: `session_start` -> `SessionStart`, `agent_start` -> `UserPromptSubmit`, `tool_execution_start` -> `PreToolUse`, `tool_approval_requested` -> `Notification`, `agent_end` (unless `willContinue`) -> `Stop`, `session_shutdown` -> `SessionEnd`. Nested omp sessions (`OMPCODE=1`) are skipped. Skill counts and usage are not reported for omp sessions (no `transcript_path`).
