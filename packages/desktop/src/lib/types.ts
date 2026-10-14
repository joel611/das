// Shapes returned by the daemon (packages/cli/src/server.ts, voice.ts).
export type SessionState = "idle" | "running" | "waiting" | "done" | "error";

export type Display = { expression: string; headline: string; count: number; light?: unknown };

export type DaemonState = {
  display: Display;
  sessions: number;
  devices: number;
  projects: number;
  untrustedProjects: number;
};

export type Session = {
  id: string;
  project: string | null;
  worktree: string | null;
  branch: string | null;
  cwd: string;
  state: SessionState;
  detail: string | null;
  skills: SkillUse[];
  updatedAt: number;
};

/** A skill a session ran (Skill tool call). Plugin skills are named `plugin:skill`. */
export type SkillUse = { name: string; count: number; lastAt: number };

/** Token use in the current 5-hour block, read from session transcripts (packages/cli/src/usage.ts). */
export type Usage = {
  block: {
    start: number;
    end: number;
    tokens: number;
    cacheRead: number;
    messages: number;
    burnPerMin: number;
    series: number[];
    byModel: { model: string; tokens: number }[];
    bySession: { session: string; tokens: number }[];
  } | null;
  /** Plan limits as Claude Code reports them to its status line (packages/cli/src/limits.ts); null until one has. */
  limits: {
    fiveHour: LimitWindow | null;
    sevenDay: LimitWindow | null;
    updatedAt: number;
  } | null;
};

/** Percent of a plan window used (0-100) and when it resets (epoch ms). */
export type LimitWindow = { usedPercent: number; resetsAt: number };

export type Project = {
  id: string;
  name: string;
  path: string;
  worktrees: { path: string; branch: string | null }[];
};

export type Device = { id: string; device: string; capabilities: string[]; connectedAt: number };

export type Settings = {
  roots: string[];
  port: number;
  hasToken: boolean;
  hasOpenrouterKey: boolean;
  usageApi: boolean;
  envOverrides: string[];
  trustAdvice: string | null;
  restartRequired?: boolean;
};

export type SettingsPatch = Partial<{
  roots: string[];
  port: number;
  token: string;
  openrouterKey: string;
  usageApi: boolean;
}>;

export type HookStatus = {
  state: "installed" | "partial" | "missing";
  events: Record<string, "installed" | "partial" | "missing">;
  portMatches: boolean;
  port: number;
};

export type OmpStatus = {
  state: "installed" | "missing";
  portMatches: boolean;
  port: number | null;
};

export type VoiceDebug = {
  choice: string | null;
  confidence: number;
  band: string;
  probabilities: Record<string, number>;
  alternatives: { project: string; p: number }[];
  worktree: string | null;
  cwd: string | null;
  wouldSpawn: boolean;
  name: string | null;
  thresholds: { act: number; ask: number };
};

export type VoiceReply = {
  status: "spawned" | "dry-run" | "ask" | "escalate" | "error";
  text: string;
  project?: string;
  sessionId?: string;
  debug?: VoiceDebug;
};

export type LogEntry = {
  seq: number;
  time: string;
  source: "ws" | "api";
  [k: string]: unknown;
};
