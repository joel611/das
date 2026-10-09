import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type Worktree = { path: string; branch: string | null };
export type Project = { id: string; name: string; path: string; worktrees: Worktree[] };

const SKIP = new Set(["node_modules", "Library", "target", "dist"]);

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};

/** Directories containing `.git` (dir or file). Stops descending at a git root. */
export function findCheckouts(root: string, depth = 6): string[] {
  if (depth < 0 || !existsSync(root)) return [];
  if (existsSync(join(root, ".git"))) return [root];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
    .flatMap((e) => findCheckouts(join(root, e.name), depth - 1));
}

function listWorktrees(cwd: string): Worktree[] {
  const out = git(cwd, "worktree", "list", "--porcelain");
  if (!out) return [{ path: cwd, branch: null }];
  return out.split("\n\n").flatMap((block) => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path || /^bare$/m.test(block)) return [];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    return [{ path, branch }];
  });
}

/** Group checkouts into projects by git common dir, so all worktrees of a repo are one project. */
export function scan(roots: string[]): Project[] {
  const byCommon = new Map<string, string>(); // common dir -> a checkout path
  for (const checkout of roots.flatMap((r) => findCheckouts(r))) {
    const common = git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (common && !byCommon.has(common)) byCommon.set(common, checkout);
  }
  return [...byCommon].map(([common, checkout]) => {
    const path = basename(common) === ".git" ? dirname(common) : common;
    return { id: path, name: basename(path), path, worktrees: listWorktrees(checkout) };
  });
}

/** Longest-prefix match of a session cwd against all worktrees. Worktree paths are real paths, so a cwd reached through a symlink is retried resolved. */
export function matchProject(projects: Project[], cwd: string): { project: Project; worktree: Worktree } | null {
  const match = (dir: string) => {
    let best: { project: Project; worktree: Worktree } | null = null;
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        const inside = dir === worktree.path || dir.startsWith(worktree.path + "/");
        if (inside && (!best || worktree.path.length > best.worktree.path.length)) best = { project, worktree };
      }
    }
    return best;
  };
  const direct = match(cwd);
  if (direct || !cwd) return direct;
  try {
    return match(realpathSync(cwd));
  } catch {
    return null; // cwd no longer exists
  }
}
