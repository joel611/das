import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim().slice(0, 200)}`);
  return r.stdout.toString().trim();
};

/** For agents with no worktree flag of their own: `<repo>/.das/worktrees/<name>` on a new branch, kept out of `git status` via info/exclude. */
export function dasWorktree(cwd: string, name: string): string {
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
