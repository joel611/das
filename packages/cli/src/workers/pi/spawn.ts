import { closeSync, openSync } from "node:fs";
import type { SpawnResult } from "../worker";
import { dasWorktree } from "../worktree";

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
    const proc = Bun.spawn([bin, "-p", prompt], {
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
