import { expect, test } from "bun:test";
import { snapshotText } from "./snapshot";
import type { Session } from "./sessions";

const session: Session = {
  id: "s1",
  agent: "claude",
  project: "alpha",
  worktree: "/p/.claude/worktrees/orch-alpha-1",
  branch: "orch-alpha-1",
  cwd: "/p/.claude/worktrees/orch-alpha-1",
  state: "running",
  detail: "Bash",
  skills: [],
  transcript: null,
  events: [{ event: "PreToolUse", at: 1000 }],
  updatedAt: 1000,
};

test("worker claims and verified diff are labelled apart", () => {
  const text = snapshotText({
    session,
    now: 11_000,
    transcript: {
      lastAssistant: "almost there",
      todos: [{ content: "write tests", status: "in_progress" }],
      recentTools: [{ name: "Bash", input: '{"command":"ls"}' }],
    },
    summary: "shipped it",
    openBatch: undefined,
    git: { diffStat: " a.ts | 2 +-", commits: "abc fix" },
  });
  expect(text).toContain("worker-reported");
  expect(text).toContain("shipped it");
  expect(text).toContain("daemon-verified");
  expect(text).toContain("a.ts | 2 +-");
  expect(text).toContain("[in_progress] write tests");
  expect(text).toContain("PreToolUse 10s ago");
  expect(text).toContain("almost there");
});

test("open question batch is shown", () => {
  const text = snapshotText({
    session,
    now: 2000,
    transcript: { lastAssistant: "", todos: [], recentTools: [] },
    openBatch: { questions: ["sqlite?"], status: "pending" },
    git: { diffStat: "", commits: "" },
  });
  expect(text).toContain("open questions (pending)");
  expect(text).toContain("1. sqlite?");
  expect(text).toContain("no uncommitted changes");
});
