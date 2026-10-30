import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Spawner = (
  cwd: string,
  prompt: string,
  name: string,
) => Promise<{ id: string | null; stdout: string }>;

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
  "-n",
  name,
  prompt,
];

export const claudeSpawner: Spawner = async (cwd, prompt, name) => {
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
};

export type WorkerKind = "claude" | "pi";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim().slice(0, 200)}`);
  return r.stdout.toString().trim();
};

/** Where das puts pi worktrees: `<repo>/.das/worktrees/<name>`, kept out of `git status` via info/exclude. */
export function piWorktree(cwd: string, name: string): string {
  const top = git(cwd, "rev-parse", "--show-toplevel");
  const path = join(top, ".das", "worktrees", name);
  git(cwd, "worktree", "add", "-b", name, path, "HEAD");
  const exclude = join(
    git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    "info",
    "exclude",
  );
  const lines = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!lines.split("\n").includes(".das/")) {
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${lines && !lines.endsWith("\n") ? "\n" : ""}.das/\n`);
  }
  return path;
}

/**
 * pi has no `--bg` or `--worktree`, so das makes the worktree and runs `<PI_BIN> -p <prompt>` detached in it
 * (a daemon restart does not kill it). Output goes to `<worktree>.log`. The session id arrives later
 * through the omp extension's hooks, so it is null here.
 */
export const piSpawner: Spawner = async (cwd, prompt, name) => {
  const wt = piWorktree(cwd, name);
  const bin = process.env.PI_BIN || "omp";
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
};

export const spawners: Record<WorkerKind, Spawner> = { claude: claudeSpawner, pi: piSpawner };
