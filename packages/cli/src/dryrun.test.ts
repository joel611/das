import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decider, Decision } from "./router";
import type { Project } from "./scanner";
import { createServer } from "./server";
import type { Spawner } from "./spawner";
import { handleTranscript, type VoiceDeps } from "./voice";

const projects: Project[] = [
  {
    id: "/p/alpha",
    name: "alpha",
    path: "/p/alpha",
    worktrees: [
      { path: "/p/alpha", branch: "main" },
      { path: "/p/alpha-wt", branch: "feat/x" },
    ],
  },
  {
    id: "/p/beta",
    name: "beta",
    path: "/p/beta",
    worktrees: [{ path: "/p/beta", branch: "main" }],
  },
];
const dec = (
  project: string | null,
  confidence: number,
  extra: Partial<Decision> = {},
): Decision => ({
  project,
  confidence,
  alternatives: [
    { project: "alpha", p: 0.5 },
    { project: "beta", p: 0.4 },
  ],
  ...extra,
});
const logPath = join(mkdtempSync(join(tmpdir(), "console-")), "d.jsonl");
const mk = (decisions: Decision[]) => {
  const spawns: any[] = [];
  const decider: Decider = async () => decisions.shift()!;
  const spawner: Spawner = async (cwd, prompt, name) => (
    spawns.push({ cwd, prompt, name }),
    { id: "abc-123", stdout: "id abc-123" }
  );
  const deps: VoiceDeps = {
    decider,
    spawner,
    getProjects: () => projects,
    pending: new Map(),
    logPath,
  };
  return { deps, spawns };
};

test("dry run never spawns, returns debug, logs dry-run", async () => {
  const { deps, spawns } = mk([dec("alpha", 0.9, { worktree: "/p/alpha-wt" })]);
  const r = await handleTranscript(deps, "dry1", "fix it", { dryRun: true });
  expect(spawns.length).toBe(0);
  expect(r).toMatchObject({ status: "dry-run", text: "Would start in alpha", project: "alpha" });
  expect(r.debug).toMatchObject({
    choice: "alpha",
    confidence: 0.9,
    band: "spawn",
    wouldSpawn: true,
    cwd: "/p/alpha-wt",
    worktree: "/p/alpha-wt",
    thresholds: { act: 0.8, ask: 0.4 },
  });
  expect(r.debug!.name).toMatch(/^voice-alpha-\d+$/);
  expect(r.debug!.probabilities).toEqual({ alpha: 0.5, beta: 0.4 });
  const lines = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines.find((l) => l.device === "dry1")).toMatchObject({
    outcome: "dry-run",
    dryRun: true,
    band: "spawn",
  });
});

test("ask in dry run keeps pending and a follow-up resolves", async () => {
  const { deps, spawns } = mk([dec("alpha", 0.5), dec("beta", 0.95)]);
  const a = await handleTranscript(deps, "d", "fix the bug", { dryRun: true });
  expect(a).toMatchObject({ status: "ask", text: "Which one, alpha or beta?" });
  expect(a.debug).toMatchObject({ band: "ask", wouldSpawn: false, name: null });
  expect(deps.pending.get("d")?.previous).toBe("fix the bug");
  const b = await handleTranscript(deps, "d", "the second one", { dryRun: true });
  expect(b).toMatchObject({ status: "dry-run", project: "beta" });
  expect(deps.pending.size).toBe(0);
  expect(spawns.length).toBe(0);
});

test("normal requests keep their shape; debug only when asked", async () => {
  const { deps, spawns } = mk([dec("beta", 0.9), dec("beta", 0.9), dec(null, 0.9)]);
  expect(await handleTranscript(deps, "d", "x")).toEqual({
    status: "spawned",
    text: "Started in beta",
    project: "beta",
    sessionId: "abc-123",
  });
  expect(spawns.length).toBe(1);
  const r = await handleTranscript(deps, "d", "x", { debug: true });
  expect(r.status).toBe("spawned");
  expect(r.debug?.wouldSpawn).toBe(true);
  expect(spawns.length).toBe(2);
  const e = await handleTranscript(deps, "d", "weather", { dryRun: true });
  expect(e).toMatchObject({
    status: "escalate",
    debug: { choice: null, band: "escalate", wouldSpawn: false },
  });
});

const m = mk(Array.from({ length: 6 }, () => dec("beta", 0.95)));
const server = createServer({
  port: 0,
  token: "secret",
  getProjects: () => projects,
  decider: m.deps.decider,
  spawner: m.deps.spawner,
  decisionsLog: logPath,
});
afterAll(() => server.stop(true));

test("POST /v1/voice dryRun true / false / absent, auth unchanged", async () => {
  const url = `http://localhost:${server.port}/v1/voice`;
  const post = (body: object, auth = true) =>
    fetch(url, {
      method: "POST",
      headers: auth ? { Authorization: "Bearer secret" } : {},
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<any>);
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);

  const dry = await post({ text: "x", dryRun: true });
  expect(dry).toMatchObject({ status: "dry-run", debug: { wouldSpawn: true } });
  expect(m.spawns.length).toBe(0);

  expect(await post({ text: "x", dryRun: false })).toEqual({
    status: "spawned",
    text: "Started in beta",
    project: "beta",
    sessionId: "abc-123",
  });
  expect(m.spawns.length).toBe(1);
  expect(await post({ text: "x" })).toEqual({
    status: "spawned",
    text: "Started in beta",
    project: "beta",
    sessionId: "abc-123",
  });
  expect(m.spawns.length).toBe(2);
  expect((await post({ text: "x", debug: true })).debug.choice).toBe("beta");
  expect(m.spawns.length).toBe(3);
});
