# Research: detecting Claude Code subagents for the dashboard

Date: 2026-10-14. Claude Code on this machine: 2.1.294 (`version` field in transcripts).

## Summary

- The daemon today knows nothing about subagents. It keys sessions by `session_id`, and a subagent's hooks carry the parent's `session_id`, so subagent tool calls would overwrite the parent's `detail`.
- Claude Code gives two primary signals: hook events `SubagentStart` / `SubagentStop` (with `agent_id`, `agent_type`), and an `agent_id` / `agent_type` field on every hook that fires inside a subagent.
- On disk, each subagent has its own `subagents/agent-<id>.jsonl` plus `agent-<id>.meta.json` (type, description, parent `toolUseId`, `spawnDepth`) under the parent session directory.
- Cheapest path: install `SubagentStart` and `SubagentStop` hooks, track subagents per `session_id` in `SessionTracker`, and show a count and list on the session card. Use the meta file only for enrichment.

## How current repo ingests sessions

- Hooks only, posted to the daemon: events `SessionStart, UserPromptSubmit, PreToolUse, Notification, Stop, SessionEnd` — `packages/cli/src/hooks-install.ts:16-23`; command is a fire-and-forget `curl` to `/hooks/<event>` — `hooks-install.ts:31-32`. Design intent also in `docs/product.md` section 2.
- Ingest route `POST /hooks/:event` — `packages/cli/src/api/server.ts:135-143`: calls `tracker.handleHook(event, payload)` and `usage.ingest(session_id, transcript_path)`.
- `HookPayload` has only `session_id, cwd, tool_name, tool_input.skill, prompt, message, transcript_path` — `packages/cli/src/sessions.ts:22-30`. No `agent_id` / `agent_type`.
- `handleHook` keys on `session_id` (`sessions.ts:67,72`); unknown events hit `default: return null` (`sessions.ts:107-108`), so `SubagentStart`/`SubagentStop` are dropped even if posted.
- `PreToolUse` sets `state=running, detail=tool_name` (`sessions.ts:95-98`) with no agent check.
- Usage reads only `<root>/<project>/<session>.jsonl`; a comment says subagent transcripts "live deeper and are not reported by hooks, so they are not counted here either" — `packages/cli/src/usage.ts:111-114`.
- Dashboard `Session` type has no subagent field — `packages/desktop/src/lib/types.ts:14-24`; rollup in `packages/cli/src/display.ts:17-22`.

## Detection signals

### 1. `SubagentStart` / `SubagentStop` hook events (recommended)

Source: https://code.claude.com/docs/en/hooks (sections SubagentStart, SubagentStop; fetched 2026-10-14).

- Event table: `SubagentStart` "When a subagent is spawned"; `SubagentStop` "When a subagent finishes".
- SubagentStart "Runs when Claude spawns a subagent with the Agent tool, when Claude resumes a subagent, and each time an in-process agent team teammate handles a new message." Payload example: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `agent_id`, `agent_type`.
- SubagentStop adds `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path` (stored in a nested `subagents/` folder), `last_assistant_message`. `transcript_path` is the main session's transcript.
- Caveat (docs): "Not every SubagentStop event comes from a subagent Claude spawned. Claude Code also runs internal agents ... prompt suggestions and `/btw` side questions"; `agent_type` may be empty for those. Filter on non-empty `agent_type`.
- Caveat: SubagentStart also fires on resume and per teammate message, so dedupe by `agent_id`.
- Empirical: subagent transcripts contain `hook_success` attachments; counts by `hookEvent` over all `~/.claude/projects/*/*/subagents/*.jsonl`: SubagentStart=109, SubagentStop=62. Example `hookName: "SubagentStart:Explore"` in `~/.claude/projects/-Users-joel-chan-Projects-sen-ryo-ordering-site/c8825e2f-4cf8-4173-8f1e-546e2a9ee6fb/subagents/agent-a5b07e246be35eb6a.jsonl` (line 2).

### 2. `agent_id` / `agent_type` on every hook inside a subagent

Source: same doc, "Common input fields": "`agent_id` and `agent_type` tell your script which agent a hook fired in, such as a subagent, an in-process teammate, or the agent you chose with `--agent`." `agent_type`: "Present when the session uses `--agent` or the hook fires inside a subagent."

- Use: in `handleHook`, if `agent_id` is set, attribute `PreToolUse` detail to that subagent, not the parent. Absent `agent_id` means the main agent. (`agent_type` alone is not a safe test, since `--agent` sets it on the main session.)
- Empirical: 1536 `PreToolUse` and 1243 `PostToolUse` hook attachments sit in subagent transcripts, so these hooks fire inside subagents here. I did not capture a raw payload to confirm the `agent_id` field itself; the doc is the source.

### 3. `Agent` tool call in the parent (PreToolUse / PostToolUse)

Source: hooks doc, tool input table "Agent": `prompt`, `description`, `subagent_type`, `model`. PostToolUse `tool_response`: `status` (`completed` | `async_launched`), `agentId`, `content`, `resolvedModel`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage`. Docs: "Subagents run in the background by default" so `async_launched` is common and carries no usage.

- Tool name is `Agent` on this version. Empirical scan of `~/.claude/projects/*/*.jsonl`: 60 `tool_use` blocks named `Agent`, 0 named `Task`. Older versions used `Task`; match both.
- The daemon already receives `PreToolUse` with `tool_name:"Agent"` (shown as `detail`); `tool_input.description` / `subagent_type` are available with no new hook.
- Parent link: the `tool_use` has `id` (`toolu_01AM9Tt5...`), `input.description`, `input.subagent_type`; its result record has `toolUseResult.agentId: "a5b07e246be35eb6a"`, `status: "async_launched"`, in `.../c8825e2f-4cf8-4173-8f1e-546e2a9ee6fb.jsonl`.
- `agentId` there has no `agent-` prefix, while the doc's SubagentStart example shows `"agent-abc123"` and the file is `agent-<agentId>.jsonl`. Normalize by stripping a leading `agent-`.

### 4. On-disk subagent transcript and meta file

Layout (empirical; 57 meta files, 114 files in `subagents/` dirs): `~/.claude/projects/<encoded-cwd>/<session_id>/subagents/agent-<agentId>.jsonl` and `.meta.json`. Doc confirms the folder via `agent_transcript_path` = `~/.claude/projects/.../abc123/subagents/agent-def456.jsonl`.

- `meta.json` keys (of 57): `agentType`, `description`, `toolUseId`, `spawnDepth`, `requestShape`, `requestNonInteractive` (all); `model` (11), `worktreePath`, `spawnedWithWorktree` (5), `stoppedByUser` (1). Example: `{"agentType":"Explore","description":"Explore order-service addon endpoint","toolUseId":"toolu_01AM9T...","spawnDepth":1,"requestShape":"background","requestNonInteractive":true,"stoppedByUser":true}`.
- `toolUseId` equals the parent `Agent` `tool_use.id`: a reliable join.
- Each subagent transcript line has `isSidechain: true`, `agentId`, `sessionId` (= parent session id), `parentUuid` (first line null), `cwd`, `version`.
- Main transcripts contain no `isSidechain:true` lines (empirical scan: 0), so `isSidechain` identifies subagent files only.
- The meta.json format is not documented; the hooks doc documents only the path (`agent_transcript_path`). Treat meta fields as best-effort.

### 5. Not checked

Statusline and settings docs were not read; the hooks reference was sufficient and the statusline only runs inside the interactive session, not the daemon.

## Display options for dashboard

| Option | Data | Cost | Notes |
|---|---|---|---|
| A. Badge "N subagents running" on session card | `SubagentStart`/`Stop` per `session_id` | Small: add 2 events, extend `Session` | Fits goal "know what every agent is doing" |
| B. Nested list under session: type, description, state, last tool | A plus `agent_id` on `PreToolUse`, description from `Agent` `tool_input` or meta.json | Medium | Join meta by `toolUseId` |
| C. Subagents as top-level sessions | `agent_id` as its own row | Medium | Inflates device `count`/headline (`display.ts:17-22`); not recommended |
| D. Per-subagent tokens | Read `subagents/*.jsonl` in `usage.ts` | Medium | Currently excluded (`usage.ts:111-114`), so block totals under-count; separate decision |

Keep `computeDisplay` over parent sessions only so the robot headline is unchanged.

## Recommendation

1. Add `SubagentStart` and `SubagentStop` to `EVENTS` (`hooks-install.ts:16`); user re-clicks "Install hooks" and restarts sessions.
2. Extend `HookPayload` with `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `tool_input.description`, `tool_input.subagent_type`.
3. Add `subagents: {id, type, description?, state, detail, startedAt, endedAt?}[]` to `Session`; Start upserts by `agent_id`, Stop marks done (ignore empty `agent_type`).
4. When `agent_id` is present on `PreToolUse`/`Notification`, update that subagent only; do not overwrite the parent's `state`/`detail`.
5. Mirror the field in `packages/desktop/src/lib/types.ts` and render option B in `views/overview.tsx`; leave device `display` as is.
6. Prune subagents on parent `SessionEnd`; apply a TTL for ones whose `SubagentStop` never arrives.

## Open questions

- Does a user-stopped or crashed subagent always emit `SubagentStop`? Not verified (one meta has `stoppedByUser: true`). Counts 109 start vs 62 stop are not a clean comparison (start also fires on resume), so a TTL is prudent.
- Do background subagents keep running after the parent's `Stop`? Docs scope `background_tasks` to the parent session; lifecycle after parent `Stop` not verified.
- Nested subagents: meta has `spawnDepth`; docs read here do not say how deeper levels appear in hooks. Not verified.
- Capture one live `PreToolUse` payload from inside a subagent (log in the hook route) to confirm `agent_id` before relying on it.
- Should subagent tokens count toward the 5-hour block in `usage.ts`? Product decision.
- Version drift: `Agent` vs `Task` tool name and meta.json fields may change; the hook events are the documented surface.

## Live verification (2026-10-14)

Ran nested `claude -p` (haiku) with logging hooks; parent spawned one `general-purpose` subagent that ran `echo hello`. Raw payloads: 9 events, one session_id.

Observed order:
1. `PreToolUse` tool=`Agent` — **no** `agent_id` (parent-level).
2. `SubagentStart` — `agent_id`, `agent_type`; no `agent_transcript_path`.
3. `PreToolUse` / `PostToolUse` tool=`Bash` — **carry `agent_id` + `agent_type`** (confirmed; same `session_id` as parent).
4. `PreToolUse` / `PostToolUse` tool=`SubagentHandback` — carry `agent_id` (internal tool; filter it out of "current tool").
5. `SubagentStop` — has `agent_transcript_path` (`.../subagents/agent-<id>.jsonl`), plus `background_tasks`, `session_crons`.
6. `PostToolUse` tool=`Agent` — no `agent_id`.
7. `Stop` — parent only, no `agent_id`.

Resolved: agent_id on live PreToolUse = **yes**. Same session_id for parent and subagent = yes, so `agent_id` is the only discriminator.
Still unverified: SubagentStop on user-interrupted agent; nested depth.
