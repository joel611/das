import type { SpawnResult, Worker, WorkerId } from "./worker";

/** A Worker whose spawn is the given function, for tests. `send` and `cancel` record into `sent` and `cancelled`. */
export const fakeWorker = (
  spawn: (cwd: string, prompt: string, name: string) => Promise<SpawnResult>,
  id: WorkerId = "claude",
): Worker & { sent: { sessionId: string; cwd: string; text: string }[]; cancelled: string[] } => {
  const sent: { sessionId: string; cwd: string; text: string }[] = [];
  const cancelled: string[] = [];
  return {
    id,
    spawn,
    send: async (sessionId, cwd, text) => void sent.push({ sessionId, cwd, text }),
    cancel: async (sessionId) => void cancelled.push(sessionId),
    sent,
    cancelled,
  };
};
