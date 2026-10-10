# @stackchan/cli: the daemon

```sh
bun run daemon            # foreground (from the repo root)
bun run daemon --bg       # detached; log and pid in the settings dir
bun run daemon --status   # running (pid, port) or "not running" (exit 1)
bun run daemon --stop
bun run test              # bun tests for this package
```

Settings dir: `~/Library/Application Support/stack-chan-server/` (or `$STACKCHAN_CONFIG_DIR`) holds `config.json`, `daemon.pid` and `daemon.log`.

The daemon does not need the desktop app. The desktop app does not own the daemon: it shows its status and talks to it over the API below.

## Settings

`config.json` (mode 0600): `{roots, port, token, openrouterKey}`. Precedence: env (`PROJECT_ROOTS`, `PORT`, `TOKEN`, `OPENROUTER_API_KEY`) over the file over defaults. Token and OpenRouter key are write-only in the API (`hasToken`, `hasOpenrouterKey`). A root change rescans at once; a token change applies at once; a port change replies `restartRequired: true` and needs `daemon --stop` then `--bg`.

## WebSocket protocol

`WS /v1/ws` (JSON text frames). Auth: `Authorization: Bearer <TOKEN>` or `?token=<TOKEN>` (only when `TOKEN` is set).

| Direction        | Frame                                                                                |
| ---------------- | ------------------------------------------------------------------------------------ |
| client -> server | `{"type":"hello","device":"name","capabilities":["display"]}`                        |
| server -> client | `{"type":"snapshot","projects":[...],"sessions":[...],"display":D}` (reply to hello) |
| server -> client | `{"type":"delta","session":{...},"display":D}` (session changed)                     |
| server -> client | `{"type":"delta","removed":"<sessionId>","display":D}` (SessionEnd)                  |

`D = {"expression":"focused|worried|happy|sad|neutral","headline":"3 running","count":3}`.
Rollup priority: error > waiting > running > done > idle. `button` is reserved (ignored); unknown messages are ignored.

Try it:

```sh
bun packages/cli/scripts/mock-client.ts ws://localhost:4321/v1/ws
curl -X POST localhost:4321/hooks/UserPromptSubmit -d '{"session_id":"s1","cwd":"/tmp"}'
curl -X POST localhost:4321/hooks/Stop -d '{"session_id":"s1"}'
curl -X POST localhost:4321/hooks/SessionEnd -d '{"session_id":"s1"}'
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

| Route                                              | Result                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/settings`                              | `{roots, port, hasToken, hasOpenrouterKey, envOverrides, trustAdvice}`                                                                       |
| `PUT /admin/settings`                              | body: any of `roots` (existing dirs), `port` (1-65535), `token`, `openrouterKey` (`""` clears); returns the GET shape plus `restartRequired` |
| `GET /admin/hooks`                                 | `{state: installed\|partial\|missing, installed, enabled, legacy, port, portMatches}` for the hook plugin                                    |
| `POST /admin/hooks/install`, `DELETE /admin/hooks` | same shape after the change                                                                                                                  |
| `GET /v1/projects`, `GET /v1/sessions`             | scanned projects (worktrees grouped), tracked sessions                                                                                       |
| `GET /v1/devices`                                  | `[{id, device, capabilities, connectedAt}]` (from `hello`)                                                                                   |
| `GET /v1/state`                                    | `{display, sessions, devices, projects, untrustedProjects}`                                                                                  |

## Hook plugin

The hooks ship as a Claude Code plugin, [`plugins/stack-chan-hooks`](../../plugins/stack-chan-hooks), listed by this repo's own marketplace (`.claude-plugin/marketplace.json`, name `stack-chan`). Its `hooks/hooks.json` has one command hook per event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`), each running `hooks/forward.sh <Event>`, which pipes the hook JSON to `http://127.0.0.1:$CLAUDE_PLUGIN_OPTION_PORT/hooks/<Event>` with `curl -s -m 2`: no output, always exit 0, it never blocks or changes the agent. The port is the plugin's `port` option (default 4321); the script has no fallback of its own.

```sh
bun run hooks:install     # claude plugin marketplace add <repo> + claude plugin install stack-chan-hooks@stack-chan --config port=<daemon port>
bun run hooks:uninstall   # claude plugin uninstall stack-chan-hooks@stack-chan + claude plugin marketplace remove stack-chan
bun run hooks:status
```

The Settings tab and `POST /admin/hooks/install` / `DELETE /admin/hooks` do the same. Everything goes through the `claude` CLI (`$CLAUDE_BIN`, default `claude` on `PATH`; `$CLAUDE_CONFIG_DIR` is honoured), so we never edit Claude's settings ourselves: Claude records the plugin as `enabledPlugins`, `extraKnownMarketplaces` and `pluginConfigs` entries, and removes them on uninstall.

- The marketplace is a local directory, so the plugin loads in place from this checkout: edits to it apply at the next session start or `/reload-plugins`, with no reinstall. Moving the checkout needs a reinstall.
- Install is idempotent. Installing again applies a changed port and re-enables a plugin disabled in `/plugin`.
- Running Claude sessions load the plugin after a restart or `/reload-plugins`.
- Migration: install and uninstall both remove the `# stack-chan-server` command hooks that older versions wrote straight into `settings.json` (resolved through symlinks, `settings.json.bak-<timestamp>` backup first, atomic write, other hooks and keys kept). Status reports them as `legacy`.
