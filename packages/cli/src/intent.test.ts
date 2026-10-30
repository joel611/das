import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIntentRequest,
  makeJevIntentClassifier,
  parseIntentResponse,
  type Decision,
  type IntentClassifier,
  type IntentDecision,
} from "./router";
import type { Project } from "./scanner";
import type { Session } from "./sessions";
import { piWorktree, type Spawner } from "./spawner";
import { statusText } from "./status";
import { handleTranscript, type VoiceDeps } from "./voice";

const projects: Project[] = [
  {
    id: "/p/alpha",
    name: "alpha",
    path: "/p/alpha",
    worktrees: [{ path: "/p/alpha", branch: "main" }],
  },
];
const session = (over: Partial<Session>): Session => ({
  id: "s1",
  agent: "claude",
  project: "alpha",
  worktree: "/p/alpha",
  branch: "main",
  cwd: "/p/alpha",
  state: "running",
  detail: null,
  skills: [],
  updatedAt: 0,
  ...over,
});

const mk = (intent: IntentDecision | Error, sessions: Session[] = []) => {
  const steps: string[] = [];
  const classifyIntent: IntentClassifier = async () => {
    steps.push("intent");
    if (intent instanceof Error) throw intent;
    return intent;
  };
  const decision: Decision = {
    project: "alpha",
    confidence: 0.95,
    alternatives: [{ project: "alpha", p: 0.95 }],
  };
  const spawner: Spawner = async () => (steps.push("spawn"), { id: "abc", stdout: "" });
  const deps: VoiceDeps = {
    decider: async () => (steps.push("project"), decision),
    classifyIntent,
    getSessions: () => sessions,
    spawner,
    getProjects: () => projects,
    pending: new Map(),
    logPath: join(mkdtempSync(join(tmpdir(), "intent-")), "d.jsonl"),
  };
  return { deps, steps };
};

test("project intent goes on to the project classifier", async () => {
  const { deps, steps } = mk({ intent: "project", confidence: 0.9 });
  const r = await handleTranscript(deps, "d", "fix the login test in alpha", { debug: true });
  expect(r.status).toBe("spawned");
  expect(steps).toEqual(["intent", "project", "spawn"]);
  expect(r.debug?.intent).toBe("project");
});

test("status intent answers from sessions without picking a project", async () => {
  const { deps, steps } = mk({ intent: "status", confidence: 0.9 }, [
    session({ id: "a", state: "running" }),
    session({ id: "b", project: "beta", state: "waiting" }),
  ]);
  const r = await handleTranscript(deps, "d", "what's running?");
  expect(r).toEqual({ status: "status", text: "2 sessions. Running: alpha. Waiting: beta." });
  expect(steps).toEqual(["intent"]);
  const log = readFileSync(deps.logPath!, "utf8");
  expect(log).toContain('"intent":"status"');
});

test("other intent escalates without picking a project", async () => {
  const { deps, steps } = mk({ intent: "other", confidence: 0.9 });
  const r = await handleTranscript(deps, "d", "tell me a joke");
  expect(r.status).toBe("escalate");
  expect(steps).toEqual(["intent"]);
});

test("an unsure status or other verdict falls through to the project classifier", async () => {
  for (const intent of ["status", "other"] as const) {
    const { deps, steps } = mk({ intent, confidence: 0.3 });
    expect((await handleTranscript(deps, "d", "hmm alpha")).status).toBe("spawned");
    expect(steps).toEqual(["intent", "project", "spawn"]);
  }
});

test("a clarification answer skips the intent step", async () => {
  const { deps, steps } = mk({ intent: "other", confidence: 0.99 });
  deps.pending.set("d", { previous: "fix it", candidates: ["alpha", "beta"], at: Date.now() });
  expect((await handleTranscript(deps, "d", "the alpha one")).status).toBe("spawned");
  expect(steps).toEqual(["project", "spawn"]);
});

test("intent classifier error becomes status error", async () => {
  const { deps, steps } = mk(new Error("decision API 500: boom"));
  const r = await handleTranscript(deps, "d", "fix alpha");
  expect(r).toEqual({ status: "error", text: "decision API 500: boom" });
  expect(steps).toEqual(["intent"]);
});

test("intent request and parser", async () => {
  const body = buildIntentRequest("what's running");
  expect(body.model).toBe("typesafe/jev-1.13");
  expect(Object.keys(body.questions.intent.criteria)).toEqual(["project", "status", "other"]);
  expect(
    parseIntentResponse({ answers: { intent: { choice: "status", confidence: 0.8 } } }),
  ).toMatchObject({
    intent: "status",
    confidence: 0.8,
  });
  expect(() =>
    parseIntentResponse({ answers: { intent: { choice: "weather", confidence: 1 } } }),
  ).toThrow();
  expect(() => parseIntentResponse({})).toThrow();

  const fetch = (async () =>
    new Response(
      JSON.stringify({ answers: { intent: { choice: "project", confidence: 0.7 } } }),
    )) as any;
  const r = await makeJevIntentClassifier({ apiKey: "k", fetch })("fix alpha");
  expect(r.intent).toBe("project");
  await expect(makeJevIntentClassifier({ apiKey: "", fetch })("x")).rejects.toThrow();
});

test("statusText", () => {
  expect(statusText([])).toBe("Nothing is running.");
  const many = Array.from({ length: 6 }, (_, i) => session({ id: `s${i}`, project: `p${i}` }));
  expect(statusText(many)).toBe("6 sessions. Running: p0, p1, p2, p3 and 2 more.");
  expect(statusText([session({ branch: "feat/x", state: "done" })])).toBe(
    "1 session. Done: alpha on feat/x.",
  );
  expect(statusText([session({ project: null, cwd: "/tmp/scratch", state: "idle" })])).toBe(
    "1 session. Idle: scratch.",
  );
});

test("piWorktree makes a branch worktree under .das and excludes it from git status", () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-"));
  const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  run("init", "-q", "-b", "main");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = piWorktree(repo, "orch-alpha-1");
  expect(wt.endsWith(join(".das", "worktrees", "orch-alpha-1"))).toBe(true);
  expect(existsSync(join(wt, ".git"))).toBe(true);
  expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".das/\n");
  expect(run("status", "--porcelain").stdout.toString()).toBe("");
  // a second worktree does not add the exclude line twice
  piWorktree(repo, "orch-alpha-2");
  expect(
    readFileSync(join(repo, ".git", "info", "exclude"), "utf8").match(/\.das\//g)?.length,
  ).toBe(1);
});
