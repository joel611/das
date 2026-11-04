import { closeSync, openSync } from "node:fs";
import type { SpawnResult } from "../worker";
import { WORKER_RULE } from "../protocol";
import { dasWorktree } from "../worktree";

/** Runs of this daemon, so `cancel` can stop one. A run started before a daemon restart is not tracked. */
const running = new Map<string, number>();

/**
 * pi has no `--bg` or `--worktree`, so das makes the worktree and runs `<PI_BIN> -p <prompt>` detached in it
 * (a daemon restart does not kill it). Output goes to `<worktree>.log`. The session id arrives later
 * through the pi extension's hooks, so it is null here.
 */
export async function spawnPi(cwd: string, prompt: string, name: string): Promise<SpawnResult> {
  const wt = dasWorktree(cwd, name);
  const bin = process.env.PI_BIN || "pi";
  const log = openSync(`${wt}.log`, "a");
  try {
    const proc = Bun.spawn([bin, "-p", "--append-system-prompt", WORKER_RULE, prompt], {
      cwd: wt,
      stdin: "ignore",
      stdout: log,
      stderr: log,
      detached: true,
    });
    proc.unref();
  } finally {
    closeSync(log);
  }
  return { id: null, stdout: `started ${bin} in ${wt}` };
}

/** The answer is one ordinary prompt to the same pi session, run detached in the worktree like the first. */
export async function sendPi(sessionId: string, cwd: string, text: string): Promise<void> {
  const bin = process.env.PI_BIN || "pi";
  const log = openSync(`${cwd}.log`, "a");
  try {
    const proc = Bun.spawn(
      [bin, "-p", "--session", sessionId, "--append-system-prompt", WORKER_RULE, text],
      { cwd, stdin: "ignore", stdout: log, stderr: log, detached: true },
    );
    running.set(sessionId, proc.pid);
    proc.unref();
  } finally {
    closeSync(log);
  }
}

export async function cancelPi(sessionId: string): Promise<void> {
  const pid = running.get(sessionId);
  if (!pid) throw new Error("no pi run of this daemon to cancel");
  process.kill(pid);
  running.delete(sessionId);
}
