// postinstall: keep vendor/stack-chan at the latest stack-chan/stack-chan (default branch).
// Shallow-clones on first run, then fast-forward pulls. Failures only warn, so an offline
// `bun install` still succeeds. Set STACKCHAN_SKIP_VENDOR=1 to skip.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/stack-chan/stack-chan.git";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "vendor", "stack-chan");

if (process.env.STACKCHAN_SKIP_VENDOR) process.exit(0);

const git = (args) => spawnSync("git", args, { stdio: "inherit" });

let run;
if (existsSync(join(dir, ".git"))) {
  console.log(`vendor: updating ${dir}`);
  run = git(["-C", dir, "pull", "--ff-only"]);
} else {
  console.log(`vendor: cloning ${REPO} -> ${dir}`);
  mkdirSync(dirname(dir), { recursive: true });
  run = git(["clone", "--depth", "1", REPO, dir]);
}
if (run.error || run.status !== 0) {
  console.warn(
    `vendor: stack-chan ${existsSync(join(dir, ".git")) ? "update" : "clone"} failed, continuing`,
  );
}
