// Shapes returned by the daemon (packages/cli/src/server.ts, voice.ts).
export type SessionState = "idle" | "running" | "waiting" | "done" | "error";

export type Display = { expression: string; headline: string; count: number };

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
  updatedAt: number;
};

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
  envOverrides: string[];
  trustAdvice: string | null;
  restartRequired?: boolean;
};

export type SettingsPatch = Partial<{
  roots: string[];
  port: number;
  token: string;
  openrouterKey: string;
}>;

export type HookStatus = {
  state: "installed" | "partial" | "missing";
  installed: boolean;
  enabled: boolean;
  legacy: boolean;
  port: number | null;
  portMatches: boolean;
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
