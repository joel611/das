/** Marks everything das writes into an agent's config, so install, status and uninstall only touch das's own entries. */
export const MARKER = "# stack-chan-server";

export type WorkerId = "claude" | "pi";

export type SpawnResult = { id: string | null; stdout: string };

export type IntegrationStatus = {
  state: "installed" | "partial" | "missing";
  portMatches: boolean;
  port: number | null;
};

/** How das wires an agent's session events to the daemon's `/hooks/:event`. */
export interface Integration {
  status(port: number): IntegrationStatus;
  install(port: number): IntegrationStatus;
  uninstall(): IntegrationStatus;
}

/**
 * A coding agent das can start unattended and watch. `spawn` always works in its own worktree.
 * `integration` is absent when the agent's config dir was not given, so the admin API answers 501 instead of guessing a real path.
 */
export interface Worker {
  readonly id: WorkerId;
  spawn(cwd: string, prompt: string, name: string): Promise<SpawnResult>;
  readonly integration?: Integration;
}

export type Workers = Record<WorkerId, Worker>;
