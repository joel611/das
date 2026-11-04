import type { SpawnResult } from "../worker";
import { WORKER_RULE } from "../protocol";

/** Pull a session id out of `claude --bg` output (first 8+ char hex/uuid-ish token), else null. */
export function parseId(stdout: string): string | null {
  // real output: "backgrounded · 420862cc · <name>" (8 hex chars); also accept a full uuid
  const uuid = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0];
  return stdout.match(/backgrounded\s*\S*\s*([0-9a-f]{8})\b/i)?.[1] ?? null;
}

/** Voice sessions always get their own git worktree (`--worktree`), so unattended edits never touch an existing checkout. */
export const spawnArgs = (name: string, prompt: string) => [
  "--bg",
  "--worktree",
  name,
  "--permission-mode",
  "auto",
  // The ask tool blocks mid-turn; workers end the turn with <das-questions> instead (see WORKER_RULE).
  "--disallowedTools",
  "AskUserQuestion",
  "--append-system-prompt",
  WORKER_RULE,
  "-n",
  name,
  prompt,
];

export async function spawnClaude(cwd: string, prompt: string, name: string): Promise<SpawnResult> {
  const bin = process.env.CLAUDE_BIN || "claude";
  const proc = Bun.spawn([bin, ...spawnArgs(name, prompt)], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 200)}`);
  return { id: parseId(stdout), stdout };
}

async function run(args: string[], cwd?: string) {
  const bin = process.env.CLAUDE_BIN || "claude";
  const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 200)}`);
}

/** The answer goes back as one ordinary prompt: resume the session in the background under the same id. */
export const sendArgs = (sessionId: string, text: string) => ["--bg", "--resume", sessionId, text];

export const sendClaude = (sessionId: string, cwd: string, text: string) =>
  run(sendArgs(sessionId, text), cwd);

export const cancelClaude = (sessionId: string) => run(["stop", sessionId]);
