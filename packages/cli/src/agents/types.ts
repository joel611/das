import type { Project } from "../scanner";
import type { TranscriptFormat } from "../usage";

/**
 * The contract between the daemon core and a coding agent (Claude Code, Codex, pi, ...).
 *
 * The core only knows sessions, states, usage entries and projects. Everything an agent does in its
 * own way (how it reports events, where it writes transcripts, how it is started, how it is wired up)
 * lives behind an `AgentProvider`. Only `id`, `name` and `parseEvent` are required: an agent that can
 * report its lifecycle is enough to show up on the dashboard, the rest are optional capabilities.
 * See docs/agents.md.
 */

/** What a session is doing, in the core's words. Each provider maps its native events onto these. */
export type AgentEvent =
  | { type: "start" }
  | { type: "prompt" }
  /** `skill` when the tool call ran a named skill/command, so the dashboard can count it. */
  | { type: "tool"; tool: string; skill?: string }
  | { type: "waiting"; message?: string }
  | { type: "stop" }
  | { type: "end" };

export type AgentSignal = {
  /** The agent's own session id. */
  session: string;
  cwd?: string;
  event: AgentEvent;
  /** This session's transcript, read for token usage when the provider has `transcripts`. */
  transcript?: string;
};

/** Start a session in `cwd` with `prompt`. Resolves with the agent's session id when it prints one. */
export type Spawner = (
  cwd: string,
  prompt: string,
  name: string,
) => Promise<{ id: string | null; stdout: string }>;

export type IntegrationState = "installed" | "partial" | "missing";

/** Wiring the agent to report to the daemon (hooks, a plugin, a notify script...). Results are shown as-is in settings. */
export type Integration = {
  status(o: { port: number }): { state: IntegrationState; [k: string]: unknown };
  install(o: { port: number }): { state: IntegrationState; [k: string]: unknown };
  uninstall(): { state: IntegrationState; [k: string]: unknown };
};

/** Folders the agent will run in unattended. Without it every project counts as usable. */
export type Trust = {
  trusted(): string[];
  isTrusted(path: string, trusted: string[]): boolean;
  /** Human advice for projects the agent would refuse, or null when all are fine. */
  advice(roots: string[], projects: Project[], trusted: string[]): string | null;
};

export type AgentProvider = {
  /** Stable id, used in URLs (`/hooks/<id>/<event>`) and on sessions. */
  id: string;
  name: string;
  /** Translate one native event, as the agent posted it, into a signal; null ignores it. */
  parseEvent(event: string, payload: unknown): AgentSignal | null;
  transcripts?: TranscriptFormat;
  integration?: Integration;
  spawn?: Spawner;
  trust?: Trust;
};

/** What `/v1/agents` reports: which capabilities each provider has. */
export const describe = (a: AgentProvider) => ({
  id: a.id,
  name: a.name,
  usage: !!a.transcripts,
  integration: !!a.integration,
  spawn: !!a.spawn,
  trust: !!a.trust,
});
