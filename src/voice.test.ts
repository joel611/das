import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBands, buildRequest, makeJevDecider, parseResponse, type Decider, type Decision } from "./router";
import type { Project } from "./scanner";
import { createServer } from "./server";
import { parseId, type Spawner } from "./spawner";
import { handleTranscript, type VoiceDeps } from "./voice";

const projects: Project[] = [
  { id: "/p/alpha", name: "alpha", path: "/p/alpha", worktrees: [{ path: "/p/alpha", branch: "main" }, { path: "/p/alpha-wt", branch: "feat/x" }] },
  { id: "/p/beta", name: "beta", path: "/p/beta", worktrees: [{ path: "/p/beta", branch: "main" }] },
];
const dec = (project: string | null, confidence: number, extra: Partial<Decision> = {}): Decision => ({
  project,
  confidence,
  alternatives: [{ project: "alpha", p: 0.5 }, { project: "beta", p: 0.4 }],
  ...extra,
});
const logDir = mkdtempSync(join(tmpdir(), "voice-"));
const logPath = join(logDir, "sub", "d.jsonl");
const mk = (decisions: Decision[]) => {
  const calls: any[] = [];
  const spawns: any[] = [];
  const decider: Decider = async (t, _p, ctx) => (calls.push({ t, ctx }), decisions.shift()!);
  const spawner: Spawner = async (cwd, prompt, name) => (spawns.push({ cwd, prompt, name }), { id: "abc-123", stdout: "id abc-123" });
  const deps: VoiceDeps = { decider, spawner, getProjects: () => projects, pending: new Map(), logPath };
  return { deps, calls, spawns };
};

test("bands", () => {
  const cases: [string | null, number, string][] = [
    ["alpha", 0.95, "spawn"], ["alpha", 0.8, "spawn"], ["alpha", 0.79, "ask"], ["alpha", 0.4, "ask"],
    ["alpha", 0.39, "escalate"], [null, 0.99, "escalate"],
  ];
  for (const [project, confidence, band] of cases) expect(applyBands({ project, confidence }, { act: 0.8, ask: 0.4 })).toBe(band);
});

test("spawn uses transcript verbatim, worktree cwd, and logs", async () => {
  const { deps, spawns } = mk([dec("alpha", 0.9, { worktree: "/p/alpha-wt" })]);
  const r = await handleTranscript(deps, "d", "fix the bug");
  expect(r).toEqual({ status: "spawned", text: "Started in alpha", project: "alpha", sessionId: "abc-123" });
  expect(spawns[0].cwd).toBe("/p/alpha-wt");
  expect(spawns[0].prompt).toBe("fix the bug");
  expect(spawns[0].name).toMatch(/^voice-alpha-\d+$/);
  const line = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n")[0]);
  expect(line).toMatchObject({ transcript: "fix the bug", choice: "alpha", confidence: 0.9, band: "spawn", outcome: "spawned" });
  expect(JSON.stringify(line)).not.toContain("Bearer");
});

test("unknown worktree falls back to project path", async () => {
  const { deps, spawns } = mk([dec("beta", 0.9, { worktree: "/etc" })]);
  await handleTranscript(deps, "d", "x");
  expect(spawns[0].cwd).toBe("/p/beta");
});

test("ask then resolve with context", async () => {
  const { deps, calls, spawns } = mk([dec("alpha", 0.5), dec("beta", 0.95)]);
  const a = await handleTranscript(deps, "d", "fix the bug");
  expect(a).toEqual({ status: "ask", text: "Which one, alpha or beta?" });
  expect(spawns.length).toBe(0);
  const b = await handleTranscript(deps, "d", "the second one");
  expect(calls[1].ctx).toEqual({ previous: "fix the bug", candidates: ["alpha", "beta"] });
  expect(b.status).toBe("spawned");
  expect(spawns[0].prompt).toBe("the second one");
  expect(deps.pending.size).toBe(0);
});

test("escalate: none, low confidence, unknown project, empty, too long", async () => {
  const { deps, spawns } = mk([dec(null, 0.99), dec("alpha", 0.2), dec("ghost", 0.99)]);
  for (const t of ["weather", "mumble", "do it"]) expect((await handleTranscript(deps, "d", t)).status).toBe("escalate");
  expect((await handleTranscript(deps, "d", "   ")).status).toBe("escalate");
  expect((await handleTranscript(deps, "d", "x".repeat(1001))).status).toBe("escalate");
  expect(spawns.length).toBe(0);
});

test("decider and spawner errors become status error", async () => {
  const { deps } = mk([]);
  deps.decider = async () => { throw new Error("OPENROUTER_API_KEY is not set"); };
  expect(await handleTranscript(deps, "d", "x")).toEqual({ status: "error", text: "OPENROUTER_API_KEY is not set" });
  deps.decider = async () => dec("alpha", 0.9);
  deps.spawner = async () => { throw new Error("boom"); };
  expect((await handleTranscript(deps, "d", "x")).status).toBe("error");
});

const fixture = {
  id: "g1", model: "typesafe/jev-1.13", provider: "x",
  answers: {
    project: { type: "choice", choice: "alpha", confidence: 0.91, probabilities: { alpha: 0.91, beta: 0.05, none: 0.04 } },
    worktree: { type: "choice", choice: "alpha@feat/x", confidence: 0.7, probabilities: { "alpha@main": 0.2, "alpha@feat/x": 0.7 } },
  },
  usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 },
};

test("jev request builder", () => {
  const body: any = buildRequest("hi", projects, { previous: "p", candidates: ["alpha", "beta"] });
  expect(body.model).toBe("typesafe/jev-1.13");
  expect(Object.keys(body.questions.project.criteria)).toEqual(["alpha", "beta", "none"]);
  expect(Object.keys(body.questions.worktree.criteria)).toEqual(["alpha@main", "alpha@feat/x"]);
  expect(body.state).toMatchObject({ transcript: "hi", previous_transcript: "p" });
  expect(buildRequest("hi", [projects[1]]).questions.worktree).toBeUndefined();
});

test("jev response parser", () => {
  const d = parseResponse(fixture, projects);
  expect(d).toMatchObject({ project: "alpha", confidence: 0.91, worktree: "/p/alpha-wt" });
  expect(d.alternatives.map((a) => a.project)).toEqual(["alpha", "beta"]);
  const low = structuredClone(fixture);
  low.answers.worktree.probabilities["alpha@feat/x"] = 0.3;
  expect(parseResponse(low, projects).worktree).toBeUndefined();
  expect(parseResponse({ answers: { project: { choice: "none", confidence: 0.9 } } }, projects).project).toBeNull();
  expect(() => parseResponse({}, projects)).toThrow();
});

test("jev decider: success, http error, missing key", async () => {
  let seen: any;
  const ok = makeJevDecider({ apiKey: "k", fetch: (async (_u: string, init: any) => ((seen = init), Response.json(fixture))) as any });
  expect((await ok("t", projects)).project).toBe("alpha");
  expect(seen.headers.Authorization).toBe("Bearer k");
  const bad = makeJevDecider({ apiKey: "k", fetch: (async () => Response.json({ error: { code: 401, message: "no auth" } }, { status: 401 })) as any });
  await expect(bad("t", projects)).rejects.toThrow("401: no auth");
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  await expect(makeJevDecider()("t", projects)).rejects.toThrow("OPENROUTER_API_KEY");
  if (saved) process.env.OPENROUTER_API_KEY = saved;
});

test("parseId", () => {
  expect(parseId("started 123e4567-e89b-12d3-a456-426614174000\n")).toBe("123e4567-e89b-12d3-a456-426614174000");
  expect(parseId("backgrounded · 420862cc · voice-x\n  claude attach 420862cc")).toBe("420862cc");
  expect(parseId("nothing")).toBeNull();
});

const m = mk([dec("beta", 0.95), dec("alpha", 0.9)]);
const server = createServer({ port: 0, token: "secret", getProjects: () => projects, decider: m.deps.decider, spawner: m.deps.spawner, decisionsLog: logPath });
afterAll(() => server.stop(true));

test("POST /v1/voice and WS voice.transcript", async () => {
  const base = `localhost:${server.port}`;
  expect((await fetch(`http://${base}/v1/voice`, { method: "POST", body: "{}" })).status).toBe(401);
  const r = await fetch(`http://${base}/v1/voice?token=secret`, { method: "POST", body: JSON.stringify({ text: "hello", device: "d1" }) });
  expect(await r.json()).toEqual({ status: "spawned", text: "Started in beta", project: "beta", sessionId: "abc-123" });

  const ws = new WebSocket(`ws://${base}/v1/ws?token=secret`);
  await new Promise((res) => (ws.onopen = res));
  const reply = new Promise<any>((res) => (ws.onmessage = (e) => res(JSON.parse(String(e.data)))));
  ws.send(JSON.stringify({ type: "voice.transcript", text: "do thing" }));
  expect(await reply).toEqual({ type: "voice.reply", status: "spawned", text: "Started in alpha", project: "alpha", sessionId: "abc-123" });
  ws.close();
  expect(existsSync(logPath)).toBe(true);
});
