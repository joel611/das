export type Spawner = (cwd: string, prompt: string, name: string) => Promise<{ id: string | null; stdout: string }>;

/** Pull a session id out of `claude --bg` output (first 8+ char hex/uuid-ish token), else null. */
export function parseId(stdout: string): string | null {
  // real output: "backgrounded · 420862cc · <name>" (8 hex chars); also accept a full uuid
  const uuid = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0];
  return stdout.match(/backgrounded\s*\S*\s*([0-9a-f]{8})\b/i)?.[1] ?? null;
}

/** Voice sessions always get their own git worktree (`--worktree`), so unattended edits never touch an existing checkout. */
export const spawnArgs = (name: string, prompt: string) => ["--bg", "--worktree", name, "--permission-mode", "auto", "-n", name, prompt];

export const claudeSpawner: Spawner = async (cwd, prompt, name) => {
  const bin = process.env.CLAUDE_BIN || "claude";
  const proc = Bun.spawn([bin, ...spawnArgs(name, prompt)], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 200)}`);
  return { id: parseId(stdout), stdout };
};
