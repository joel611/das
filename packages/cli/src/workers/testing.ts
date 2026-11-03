import type { SpawnResult, Worker, WorkerId } from "./worker";

/** A Worker whose spawn is the given function, for tests. */
export const fakeWorker = (
  spawn: (cwd: string, prompt: string, name: string) => Promise<SpawnResult>,
  id: WorkerId = "claude",
): Worker => ({ id, spawn });
