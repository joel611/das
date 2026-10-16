import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchProject, scan } from "./scanner";
import { SessionTracker } from "./sessions";

let root: string;

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scs-")));
  const repo = join(root, "group", "app");
  mkdirSync(repo, { recursive: true });
  sh(repo, "git", "init", "-q", "-b", "main");
  sh(
    repo,
    "git",
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  sh(repo, "git", "worktree", "add", "-q", "-b", "feat", join(root, "group", "app-feat"));
  sh(repo, "git", "worktree", "add", "-q", "-b", "nested", join(repo, ".claude", "worktrees", "n"));
  mkdirSync(join(root, "solo"));
  sh(join(root, "solo"), "git", "init", "-q");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("groups sibling and nested worktrees into one project", () => {
  const projects = scan([root]);
  expect(projects.map((p) => p.name).sort()).toEqual(["app", "solo"]);
  const app = projects.find((p) => p.name === "app")!;
  expect(app.worktrees.map((w) => w.branch).sort()).toEqual(["feat", "main", "nested"]);
});

test("matches session cwd to the deepest worktree", () => {
  const projects = scan([root]);
  const m = matchProject(projects, join(root, "group", "app", ".claude", "worktrees", "n", "src"));
  expect(m?.project.name).toBe("app");
  expect(m?.worktree.branch).toBe("nested");
  expect(matchProject(projects, "/elsewhere")).toBeNull();
});

test("a cwd reached through a symlink still matches its project", () => {
  const projects = scan([root]);
  const link = join(root, "via-link");
  symlinkSync(join(root, "solo"), link);
  expect(matchProject(projects, link)?.project.name).toBe("solo");
  expect(matchProject(projects, join(link, "sub"))).toBeNull(); // missing dir under the link: no crash, no match
});

test("hook events drive session state", () => {
  const projects = scan([root]);
  const t = new SessionTracker(() => projects);
  const cwd = join(root, "solo");
  t.handleHook("SessionStart", { session_id: "s1", cwd });
  t.handleHook("PreToolUse", { session_id: "s1", cwd, tool_name: "Edit" });
  expect(t.list()[0]).toMatchObject({ project: "solo", state: "running", detail: "Edit" });
  t.handleHook("Stop", { session_id: "s1", cwd });
  expect(t.list()[0].state).toBe("done");
  t.handleHook("SessionEnd", { session_id: "s1" });
  expect(t.list()).toHaveLength(0);
});

test("skills are counted from the Skill tool only, not from /slash prompts", () => {
  const t = new SessionTracker(() => []);
  t.handleHook("UserPromptSubmit", { session_id: "s1", cwd: "/x", prompt: "/simplify the diff" });
  t.handleHook("UserPromptSubmit", { session_id: "s1", prompt: "/Users/me/file.ts please read" });
  t.handleHook("PreToolUse", {
    session_id: "s1",
    cwd: "/x",
    tool_name: "Skill",
    tool_input: { skill: "dataviz" },
  });
  t.handleHook("PreToolUse", {
    session_id: "s1",
    tool_name: "Skill",
    tool_input: { skill: "simplify" },
  });
  t.handleHook("PreToolUse", { session_id: "s1", tool_name: "Bash", tool_input: {} });
  const s = t.list()[0];
  expect(s.skills.map((k) => [k.name, k.count])).toEqual([
    ["simplify", 1],
    ["dataviz", 1],
  ]);
});

test("sessions record which agent sent them, defaulting to claude", () => {
  const t = new SessionTracker(() => []);
  t.handleHook("SessionStart", { session_id: "c", cwd: "/x" });
  t.handleHook("SessionStart", { session_id: "o", cwd: "/x", agent: "omp" });
  t.handleHook("Stop", { session_id: "o", cwd: "/x" });
  const by = Object.fromEntries(t.list().map((s) => [s.id, s.agent]));
  expect(by).toEqual({ c: "claude", o: "omp" });
});
