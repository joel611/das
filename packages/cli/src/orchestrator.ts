// The pi orchestrator: one durable Pi conversation that every desktop and Stack-chan message goes to.
// Step one (the intent) runs in code before the model's turn; the model then routes project work through
// classify_project and dispatch_worker, and answers status questions with list_sessions.
// Worker hook events are written back into the conversation, so it knows what its workers did.
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type EntryId,
  type Storage,
} from "@earendil-works/pi-durable";
import { applyBands, intentThreshold, type Decider, type IntentClassifier } from "./router";
import type { Project } from "./scanner";
import type { ChangeEvent, Session } from "./sessions";
import type { Spawner, WorkerKind } from "./spawner";
import { statusText } from "./status";
import { MAX_TRANSCRIPT, type VoiceResult } from "./voice";

const ctx = BACKGROUND_CONTEXT;
/** Worktree names of dispatched workers start with this, so their hook events can be told apart. */
export const WORKER_PREFIX = "orch-";
const MAX_PROMPT = 4000;

export const INSTRUCTIONS = `You are Jev, the orchestrator of a personal coding command center. Messages come from a desktop app or a small robot, often as speech transcripts. Each message starts with a tag such as [intent: project 0.92], the verdict of an intent classifier that already ran.

- Project work: call classify_project with the request. Band "spawn": call dispatch_worker with that project and cwd, and the user's request as the prompt (keep their words; add context from this conversation only when the request refers to it). Band "ask": ask which of the candidates they mean, in one short question. Band "escalate": say you could not tell which project.
- Use agent "pi" only when the user asks for pi; otherwise "claude".
- Status ("what's running?"): call list_sessions and answer from it.
- Anything else: answer briefly, or say what you can do.
- Messages starting with [worker event] are notes about workers you started. Use them when asked; they need no reply of their own.

Replies are spoken aloud: one or two short sentences, no markdown, no lists.`;

export type OrchestratorDeps = {
  storage: Storage;
  models: Models;
  model: { provider: string; modelId: string };
  getProjects: () => Project[];
  getSessions: () => Session[];
  decider: Decider;
  classifyIntent?: IntentClassifier;
  spawners: Record<WorkerKind, Spawner>;
  /** How long a request waits for the answer before replying "still working". */
  waitMs?: number;
  logPath?: string;
};

export type Orchestrator = {
  handle(deviceKey: string, transcript: string, requestId?: string): Promise<VoiceResult>;
  onSession(e: ChangeEvent): void;
  close(): Promise<void>;
};

type Dispatch = { project: string; cwd: string; agent: WorkerKind; id: string | null };

const text = (s: string) => ({ output: [{ type: "text" as const, text: s }] });

/** Tools the orchestrator gets. Hard gates (allowlist, prompt size) live here, never in the prompt. */
export function orchestratorTools(
  deps: Pick<OrchestratorDeps, "getProjects" | "getSessions" | "decider" | "spawners">,
  onDispatch: (d: Dispatch) => void,
) {
  const classifyProject = defineTool({
    name: "classify_project",
    description:
      "Pick the project (and worktree) a coding request is for. Returns band spawn, ask or escalate, the project, its cwd, the confidence and up to three candidates.",
    parameters: Type.Object({ request: Type.String({ description: "The user's request" }) }),
    replay: "safe",
    execute: async (args) => {
      const projects = deps.getProjects();
      const d = await deps.decider(args.request, projects);
      const project = projects.find((p) => p.name === d.project);
      const band = d.project !== null && !project ? "escalate" : applyBands(d);
      const cwd = project
        ? project.worktrees.some((w) => w.path === d.worktree)
          ? d.worktree!
          : project.path
        : null;
      const candidates = d.alternatives
        .filter((a) => projects.some((p) => p.name === a.project))
        .slice(0, 3)
        .map((a) => a.project);
      return text(
        JSON.stringify({
          band,
          project: project?.name ?? null,
          cwd,
          confidence: d.confidence,
          candidates,
        }),
      );
    },
  });

  const dispatchWorker = defineTool({
    name: "dispatch_worker",
    description:
      "Start a coding worker on a project in its own new git worktree. Only after classify_project returned band spawn, or the user named the project when asked.",
    parameters: Type.Object({
      project: Type.String({ description: "Project name from classify_project or list_projects" }),
      prompt: Type.String({ description: "The task for the worker" }),
      cwd: Type.Optional(Type.String({ description: "A worktree path of that project" })),
      agent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("pi")])),
    }),
    // Not replay-safe: a call a crash interrupted is reported to the model, never run twice.
    execute: async (args, api) => {
      const project = deps.getProjects().find((p) => p.name === args.project);
      if (!project) throw new Error(`unknown project ${args.project}`);
      const prompt = args.prompt.trim();
      if (!prompt || prompt.length > MAX_PROMPT)
        throw new Error(`prompt must be 1-${MAX_PROMPT} characters`);
      const cwd = project.worktrees.some((w) => w.path === args.cwd) ? args.cwd! : project.path;
      const agent: WorkerKind = args.agent ?? "claude";
      const name =
        `${WORKER_PREFIX}${project.name}-${String(api.taskId).replace(/\W/g, "").slice(-8)}`
          .replace(/[^\w.-]/g, "-")
          .slice(0, 64);
      const r = await deps.spawners[agent](cwd, prompt, name);
      onDispatch({ project: project.name, cwd, agent, id: r.id });
      return text(
        `Started ${agent} in ${project.name} (worktree ${name}${r.id ? `, session ${r.id}` : ""}).`,
      );
    },
  });

  const listSessions = defineTool({
    name: "list_sessions",
    description:
      "List the coding sessions das is tracking: agent, project, branch, state and detail.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      const sessions = deps.getSessions();
      const rows = sessions.map((s) =>
        JSON.stringify({
          agent: s.agent,
          project: s.project,
          branch: s.branch,
          state: s.state,
          detail: s.detail,
          mine: isWorker(s),
        }),
      );
      return text([statusText(sessions), ...rows].join("\n"));
    },
  });

  const listProjects = defineTool({
    name: "list_projects",
    description: "List the projects workers can be started in, with their worktree branches.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () =>
      text(
        deps
          .getProjects()
          .map(
            (p) =>
              `${p.name}: ${p.worktrees.map((w) => `${w.branch ?? "(detached)"} at ${w.path}`).join("; ")}`,
          )
          .join("\n") || "No projects.",
      ),
  });

  return [classifyProject, dispatchWorker, listSessions, listProjects];
}

const isWorker = (s: Session) =>
  [s.cwd, s.worktree].some((p) => !!p && basename(p).startsWith(WORKER_PREFIX));

const NOTIFY: Session["state"][] = ["done", "waiting", "error"];

export async function createOrchestrator(deps: OrchestratorDeps): Promise<Orchestrator> {
  const dispatched: Dispatch[] = [];
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "das", tools: orchestratorTools(deps, (d) => dispatched.push(d)) }),
  );
  const harness = await Harness.open(
    deps.storage,
    { models: deps.models, registry, identity: { attribution: null } },
    ctx,
  );
  const root = await harness.root(ctx, { agent: { model: deps.model } });
  // The model and instructions follow the config on every start.
  await root.configure({ model: deps.model, instructions: INSTRUCTIONS }, ctx);
  harness.resume();

  const log = (entry: Record<string, unknown>) => {
    const path = deps.logPath ?? process.env.DECISIONS_LOG ?? "./data/decisions.jsonl";
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(
        path,
        JSON.stringify({ ts: new Date().toISOString(), orchestrator: "pi", ...entry }) + "\n",
      );
    } catch {
      // logging must never break voice handling
    }
  };

  const answerText = async (entryId: EntryId) => {
    const entry = await root.commit((tx) => tx.entry(AssistantEntry, entryId), ctx);
    const message = entry?.model?.[0];
    const content = message && "content" in message ? message.content : [];
    return (Array.isArray(content) ? content : [])
      .flatMap((c: any) => (c?.type === "text" ? [c.text as string] : []))
      .join(" ")
      .trim();
  };

  const notified = new Map<string, Session["state"]>();

  return {
    async handle(deviceKey, transcript, requestId = crypto.randomUUID()) {
      const t = (transcript ?? "").trim();
      const base = { transcript: t.slice(0, MAX_TRANSCRIPT), device: deviceKey };
      if (!t || t.length > MAX_TRANSCRIPT) {
        log({ ...base, outcome: "escalate", reason: "invalid transcript" });
        return { status: "escalate", text: "Sorry, I didn't catch that" };
      }
      // Step one runs in code, so the model cannot skip it. Its failure only loses the hint.
      const intent = await deps.classifyIntent?.(t).catch(() => undefined);
      const iMeta = intent ? { intent: intent.intent, intentConfidence: intent.confidence } : {};
      if (intent?.intent === "status" && intent.confidence >= intentThreshold) {
        log({ ...base, ...iMeta, outcome: "status" });
        return { status: "status", text: statusText(deps.getSessions()) };
      }
      const tag = intent
        ? `[intent: ${intent.intent} ${intent.confidence.toFixed(2)}]`
        : "[intent: unknown]";
      const before = dispatched.length;
      const submission = await root.submit(
        {
          type: "input",
          content: `${tag} ${t}`,
          requestId,
          entry: {
            kind: "das.message",
            data: { text: t, device: deviceKey, intent: intent?.intent ?? null },
          },
        },
        ctx,
      );
      const waiter = withCancel(ctx);
      const timer = setTimeout(() => waiter.cancel(new Error("timeout")), deps.waitMs ?? 90_000);
      let settled;
      try {
        settled = await submission.wait(waiter.context);
      } catch {
        log({ ...base, ...iMeta, outcome: "reply", reason: "timeout" });
        return { status: "reply", text: "Still working on it." };
      } finally {
        clearTimeout(timer);
      }
      if (settled.status !== "done" || settled.type !== "input") {
        log({
          ...base,
          ...iMeta,
          outcome: "error",
          reason: settled.status === "unanswered" ? settled.reason : "",
        });
        return { status: "error", text: "I couldn't answer that" };
      }
      const answer = (await answerText(settled.answer)) || "Done.";
      const spawned = dispatched.slice(before).at(-1);
      log({
        ...base,
        ...iMeta,
        outcome: spawned ? "spawned" : "reply",
        spawned,
        answer: answer.slice(0, 500),
      });
      return spawned
        ? {
            status: "spawned",
            text: answer,
            project: spawned.project,
            sessionId: spawned.id ?? undefined,
          }
        : { status: "reply", text: answer };
    },

    onSession(e) {
      if (!("session" in e)) return;
      const s = e.session;
      if (!isWorker(s) || !NOTIFY.includes(s.state) || notified.get(s.id) === s.state) return;
      notified.set(s.id, s.state);
      const name = basename(s.worktree ?? s.cwd);
      const note = `[worker event] ${s.agent} worker ${name} in ${s.project ?? "unknown project"} is ${s.state}${s.detail ? `: ${s.detail}` : ""}`;
      void root
        .submit(
          {
            type: "write",
            requestId: `worker:${s.id}:${s.state}:${s.updatedAt}`,
            entry: {
              kind: "das.worker-event",
              data: { session: s.id, project: s.project, state: s.state, detail: s.detail },
              model: [{ role: "user", content: note, timestamp: s.updatedAt }],
            },
          },
          ctx,
        )
        .catch(() => {});
    },

    close: () => harness.close(ctx),
  };
}
