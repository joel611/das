# Agent providers

The daemon tracks coding-agent sessions, but nothing in its core should know which agent it is
watching. Each agent (Claude Code today; Codex, pi, oh-my-pi and others next) plugs in as an
`AgentProvider`, and the core works only with what providers hand it: sessions, states, usage
entries.

```
 agent (native events, transcripts, CLI)
        │
        ▼
 ┌──────────────── AgentProvider ────────────────┐
 │ parseEvent   native event ─► AgentSignal       │  required
 │ transcripts  where + how to read usage         │  optional
 │ integration  install/uninstall/status wiring   │  optional
 │ spawn        start a session in a folder       │  optional
 │ trust        folders it will run unattended    │  optional
 └───────────────────────────────────────────────┘
        │
        ▼
 core: SessionTracker · UsageTracker · display · voice router · HTTP/WS API
```

## The interface

Defined in `packages/cli/src/agents/types.ts`.

| Member         | Required | What the core does with it                                                                                                                                                               |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`   | yes      | `id` namespaces routes (`/hooks/<id>/<event>`, `/admin/agents/<id>/...`) and is stamped on each session as `session.agent`. `name` is shown to people.                                    |
| `parseEvent`   | yes      | Called with the `<event>` path segment and the posted JSON body. Returns an `AgentSignal` (`{session, cwd?, event, transcript?}`) or `null` to ignore. Must never throw on bad input.  |
| `transcripts`  | no       | A `TranscriptFormat`: `root` (paths outside it are never read), `parseLine(line, session)` to a usage `Entry`, and optional `recent(since)` listing transcripts to backfill at startup. |
| `integration`  | no       | `status/install/uninstall` for whatever makes the agent post events (hooks, a plugin, a notify script). Exposed in the settings view.                                                    |
| `spawn`        | no       | `(cwd, prompt, name) => {id, stdout}`. Voice/typed requests start sessions with the default agent's `spawn`.                                                                            |
| `trust`        | no       | `trusted()`, `isTrusted(path, trusted)`, `advice(...)`: which projects the agent would refuse to run in unattended. Feeds `untrustedProjects` and startup advice.                       |

An agent that can only report its lifecycle (`id`, `name`, `parseEvent`) already shows up on the
dashboard and the robot. Each optional capability lights up one more feature; `/v1/agents` says
which ones each provider has, so the desktop can hide what an agent cannot do.

### Normalized events

| `AgentEvent.type` | Session state | Detail            | Claude Code hook   |
| ----------------- | ------------- | ----------------- | ------------------ |
| `start`           | idle          | cleared           | `SessionStart`     |
| `prompt`          | running       | cleared           | `UserPromptSubmit` |
| `tool`            | running       | tool, or `/skill` | `PreToolUse`       |
| `waiting`         | waiting       | message           | `Notification`     |
| `stop`            | done          | cleared           | `Stop`             |
| `end`             | (removed)     |                   | `SessionEnd`       |

`tool` carries an optional `skill` so skill counting works for any agent that has a notion of
skills or slash commands.

## Wiring

- The daemon builds its list in `daemon.ts` (`agents: [claudeCode({ claudeDir })]`). The first
  provider is the default.
- Events: `POST /hooks/<id>/<event>`. `POST /hooks/<event>` still goes to the default agent, so
  Claude Code hooks installed before this change keep working unchanged.
- Admin: `/admin/agents/<id>/integration` (GET, DELETE) and `.../integration/install` (POST).
  `/admin/hooks` stays as the default agent's alias, which the desktop settings view uses.
- Usage: one `UsageTracker` holds entries from every provider; each provider registers its
  `TranscriptFormat`, and a transcript path from an event is read with that agent's format only.

## Claude Code, as the reference provider

`packages/cli/src/agents/claude-code/`

| File             | Responsibility                                                                    |
| ---------------- | --------------------------------------------------------------------------------- |
| `index.ts`       | `claudeCode({ claudeDir })` assembles the provider.                               |
| `events.ts`      | Hook payload to `AgentSignal` (including Skill tool calls).                        |
| `transcripts.ts` | `<claudeDir>/projects/<project>/<session>.jsonl`: line parser and backfill lister. |
| `hooks.ts`       | Hook installer for `<claudeDir>/settings.json` (was `hooks-install.ts`).            |
| `spawner.ts`     | `claude --bg --worktree ...`.                                                      |
| `trust.ts`       | `~/.claude.json` folder trust.                                                     |

## Adding an agent

1. Create `packages/cli/src/agents/<id>/index.ts` exporting a factory that returns an
   `AgentProvider`. Start with `parseEvent` only.
2. Add it to the `agents` list in `daemon.ts`.
3. Make the agent post to `http://127.0.0.1:<port>/hooks/<id>/<event>` (by hand first, then as an
   `integration`).
4. Add `transcripts`, `spawn` and `trust` as the agent allows.
5. Test it the way `src/agents.test.ts` tests the fake agent: events in, sessions out.

### Sketches for the next agents

These are starting points from what is publicly documented about each agent, not verified against
a running install yet; each needs checking when its provider is written.

**Codex CLI** (`codex`)

- Events: Codex can run a `notify` program from `~/.codex/config.toml` with a JSON argument on
  `agent-turn-complete` (it carries the thread id and cwd). That only gives `stop`; a small
  integration script would post `/hooks/codex/turn-complete`. If Codex's own hooks are available in
  the installed version, prefer them: they would give `prompt`, `tool` and `start` too.
- Transcripts: rollout files under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; `token_count`
  events carry `last_token_usage` (input, cached input, output, reasoning). There is no message id,
  so `parseLine` would build one from session and timestamp. `recent` walks the last day's folders.
- Spawn: `codex exec` in a worktree the daemon creates (Codex has no `--worktree` flag).
- Trust: `[projects."<path>"] trust_level = "trusted"` in `config.toml`.

**pi** (`pi`, pi-mono coding agent) and **oh-my-pi** (`omp`, a pi fork)

- Events: pi loads TypeScript extensions that subscribe to session, turn and tool events; a tiny
  extension would post each one to `/hooks/pi/<event>`. That extension is the `integration`.
- Transcripts: JSONL session files under the agent's config dir (`~/.pi/agent/sessions/...`);
  assistant messages carry usage including cache read/write.
- Spawn: print mode (`pi -p "<prompt>"`) in a daemon-made worktree.
- oh-my-pi should be the same provider with a different id, binary and config dir, so it is worth
  writing pi's provider as a factory over those three.

## Open questions

- **Which agent a voice request starts.** Today it is the default agent. Options: a per-project
  default in settings, or let the router pick (`"in das with codex"`).
- **Usage across agents.** The 5-hour block is an Anthropic plan rule. With a second vendor the
  summary should probably split per agent (`byAgent`, or one block per agent) rather than blend.
- **Session id collisions.** Sessions are keyed by the agent's own id. Every agent seen so far uses
  UUIDs, so collisions are not handled; keying by `agent:id` is the fix if one ever appears.
- **Desktop.** `session.agent` is in the API; the dashboard does not show it yet.
