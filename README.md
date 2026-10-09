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

### Workspace trust

`claude --bg` refuses to start in a folder Claude Code does not trust ("Workspace not trusted"); there is no dialog in a background spawn. Trust is stored per folder in `~/.claude.json` (`projects[<path>].hasTrustDialogAccepted`), there is no `settings.json` key for it, and a trusted folder covers every subfolder (verified with `claude --bg`: a child of a trusted folder starts, a child of an untrusted one is refused). Trust is never saved for the home directory.

At startup the server reads `~/.claude.json` (read-only) and prints which scanned projects are not covered. Fix: run `claude` once in the root folder and accept the dialog. Trusting a root also lets the project hooks, `.mcp.json` and allow rules of every repo under it run, so pick the narrowest folder that holds only repos you trust. A refused spawn replies `status: "error"`, `text: "Claude does not trust <project> yet"`.
