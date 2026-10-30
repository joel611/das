import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createServer } from "./api/server";
import { createOrchestrator, type Orchestrator, type OrchestratorDeps } from "./orchestrator";
import type { Decision, IntentDecision } from "./router";
import type { Project } from "./scanner";
import type { Session } from "./sessions";
import type { Spawner } from "./spawner";

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
];
const session = (over: Partial<Session>): Session => ({
  id: "s1",
  agent: "claude",
  project: "alpha",
  worktree: "/p/alpha/.claude/worktrees/orch-alpha-1",
  branch: "orch-alpha-1",
  cwd: "/p/alpha/.claude/worktrees/orch-alpha-1",
  state: "running",
  detail: null,
  skills: [],
  updatedAt: 1,
  ...over,
});
const toolUse = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function mk(
  opts: {
    intent?: IntentDecision;
    sessions?: Session[];
    storage?: Storage;
    waitMs?: number;
    decision?: Decision;
  } = {},
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const m = faux.getModel();
  const spawns: { agent: string; cwd: string; prompt: string; name: string }[] = [];
  const spawner =
    (agent: string): Spawner =>
    async (cwd, prompt, name) => (
      spawns.push({ agent, cwd, prompt, name }),
      { id: "abc", stdout: "" }
    );
  const logPath = join(mkdtempSync(join(tmpdir(), "orch-")), "d.jsonl");
  const deps: OrchestratorDeps = {
    storage: opts.storage ?? new MemoryStorage(),
    models,
    model: { provider: m.provider, modelId: m.id },
    getProjects: () => projects,
    getSessions: () => opts.sessions ?? [],
    decider: async () =>
      opts.decision ?? {
        project: "alpha",
        worktree: "/p/alpha-wt",
        confidence: 0.93,
        alternatives: [{ project: "alpha", p: 0.93 }],
      },
    classifyIntent: async () => opts.intent ?? { intent: "project", confidence: 0.9 },
    spawners: { claude: spawner("claude"), pi: spawner("pi") },
    waitMs: opts.waitMs,
    logPath,
  };
  const orch = await createOrchestrator(deps);
  return { orch, faux, spawns, logPath };
}

test("project work: classify_project, then dispatch_worker, then a spoken answer", async () => {
  const { orch, faux, spawns, logPath } = await mk();
  faux.setResponses([
    toolUse("classify_project", { request: "fix the login test in alpha" }),
    (context) => {
      // the classifier's verdict reached the model
      const last = JSON.stringify(context.messages.at(-1));
      expect(last).toContain('\\"band\\":\\"spawn\\"');
      expect(last).toContain("/p/alpha-wt");
      return toolUse("dispatch_worker", {
        project: "alpha",
        cwd: "/p/alpha-wt",
        prompt: "fix the login test",
      });
    },
    fauxAssistantMessage("Started on alpha."),
  ]);
  const r = await orch.handle("http:desk", "fix the login test in alpha");
  expect(r).toEqual({
    status: "spawned",
    text: "Started on alpha.",
    project: "alpha",
    sessionId: "abc",
  });
  expect(spawns).toHaveLength(1);
  expect(spawns[0]).toMatchObject({
    agent: "claude",
    cwd: "/p/alpha-wt",
    prompt: "fix the login test",
  });
  expect(spawns[0].name.startsWith("orch-alpha-")).toBe(true);
  expect(readFileSync(logPath, "utf8")).toContain('"outcome":"spawned"');
  await orch.close();
});

test("the intent tag from step one is the start of the model's user message", async () => {
  const { orch, faux } = await mk({ intent: { intent: "other", confidence: 0.8 } });
  let seen = "";
  faux.setResponses([
    (context) => {
      seen = JSON.stringify(context.messages.at(-1));
      return fauxAssistantMessage("Hello!");
    },
  ]);
  const r = await orch.handle("ws:1", "hi there");
  expect(r).toEqual({ status: "reply", text: "Hello!" });
  expect(seen).toContain("[intent: other 0.80] hi there");
  await orch.close();
});

test("a sure status intent is answered from sessions without a model call", async () => {
  const { orch, faux } = await mk({
    intent: { intent: "status", confidence: 0.9 },
    sessions: [session({ state: "running" })],
  });
  const r = await orch.handle("ws:1", "what's running?");
  expect(r).toEqual({ status: "status", text: "1 session. Running: alpha on orch-alpha-1." });
  expect(faux.state.callCount).toBe(0);
  await orch.close();
});

test("dispatch_worker refuses a project outside the allowlist", async () => {
  const { orch, faux, spawns } = await mk();
  let result = "";
  faux.setResponses([
    toolUse("dispatch_worker", { project: "secret", prompt: "rm -rf" }),
    (context) => {
      result = JSON.stringify(context.messages.at(-1));
      return fauxAssistantMessage("I can't do that.");
    },
  ]);
  const r = await orch.handle("ws:1", "do it in secret");
  expect(r.status).toBe("reply");
  expect(spawns).toHaveLength(0);
  expect(result).toContain("unknown project secret");
  await orch.close();
});

test("dispatch_worker uses pi when asked and falls back to the project path for an unknown cwd", async () => {
  const { orch, faux, spawns } = await mk();
  faux.setResponses([
    toolUse("dispatch_worker", { project: "alpha", prompt: "add tests", agent: "pi", cwd: "/etc" }),
    fauxAssistantMessage("Started pi."),
  ]);
  await orch.handle("ws:1", "use pi to add tests in alpha");
  expect(spawns[0]).toMatchObject({ agent: "pi", cwd: "/p/alpha" });
  await orch.close();
});

test("worker events are written into the conversation once per state", async () => {
  const { orch, faux } = await mk();
  orch.onSession({ session: session({ state: "done", updatedAt: 5 }) });
  orch.onSession({ session: session({ state: "done", updatedAt: 6 }) }); // same state: ignored
  orch.onSession({
    session: session({ id: "other", cwd: "/p/alpha", worktree: "/p/alpha", state: "done" }),
  }); // not a worker
  orch.onSession({ removed: "s1" });
  await Bun.sleep(50);
  let seen = "";
  faux.setResponses([
    (context) => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage("It finished.");
    },
  ]);
  await orch.handle("ws:1", "did the alpha one finish?");
  // one note, not one per hook event; the instructions mention "[worker event]" too, so count the note itself
  expect(seen.match(/\[worker event\] claude worker orch-alpha-1 in alpha is done/g)).toHaveLength(
    1,
  );
  await orch.close();
});

test("a slow answer replies 'still working' and keeps running", async () => {
  const { orch, faux } = await mk({ waitMs: 20 });
  faux.setResponses([
    async () => {
      await Bun.sleep(200);
      return fauxAssistantMessage("late");
    },
  ]);
  expect(await orch.handle("ws:1", "think hard")).toEqual({
    status: "reply",
    text: "Still working on it.",
  });
  await orch.close();
});

test("the conversation survives a restart on SQLite storage", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "orch-db-")), "o.sqlite");
  const first = await mk({ storage: await openNodeSqliteStorage(file) });
  first.faux.setResponses([fauxAssistantMessage("Noted.")]);
  await first.orch.handle("ws:1", "remember the word pineapple");
  await first.orch.close();

  const second = await mk({ storage: await openNodeSqliteStorage(file) });
  let seen = "";
  second.faux.setResponses([
    (context) => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage("Pineapple.");
    },
  ]);
  expect((await second.orch.handle("ws:1", "what was the word?")).text).toBe("Pineapple.");
  expect(seen).toContain("pineapple");
  await second.orch.close();
});

test("invalid transcripts never reach the model", async () => {
  const { orch, faux } = await mk();
  expect((await orch.handle("ws:1", "   ")).status).toBe("escalate");
  expect((await orch.handle("ws:1", "x".repeat(1001))).status).toBe("escalate");
  expect(faux.state.callCount).toBe(0);
  await orch.close();
});

test("server: messages go to the orchestrator, dry runs and a failed start go to Jev", async () => {
  const handled: string[] = [];
  const fake: Orchestrator = {
    handle: async (_key, text) => (handled.push(text), { status: "reply", text: `pi: ${text}` }),
    onSession: () => {},
    close: async () => {},
  };
  const jev = {
    decider: async (): Promise<Decision> => ({ project: null, confidence: 0, alternatives: [] }),
    decisionsLog: join(mkdtempSync(join(tmpdir(), "orch-srv-")), "d.jsonl"),
  };
  const post = (port: number | undefined, body: object) =>
    fetch(`http://localhost:${port}/v1/voice`, { method: "POST", body: JSON.stringify(body) }).then(
      (r) => r.json(),
    );

  const server = createServer({
    port: 0,
    token: "",
    getProjects: () => projects,
    ...jev,
    orchestrator: async () => fake,
  });
  expect(await post(server.port, { text: "hello" })).toEqual({
    status: "reply",
    text: "pi: hello",
  });
  expect((await post(server.port, { text: "hello", dryRun: true })).status).toBe("escalate");
  expect(handled).toEqual(["hello"]);
  server.stop(true);

  const broken = createServer({
    port: 0,
    token: "",
    getProjects: () => projects,
    ...jev,
    orchestrator: async () => {
      throw new Error("no sqlite");
    },
  });
  expect((await post(broken.port, { text: "hello" })).status).toBe("escalate");
  broken.stop(true);
});
