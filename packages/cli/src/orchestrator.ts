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
import type { WorkerId, Workers } from "./workers";
import { ExchangeStore } from "./exchanges";
import { readGit, snapshotText, type GitFacts } from "./snapshot";
import { statusText } from "./status";
import { isWorker, WORKER_PREFIX, WorkerTurns, type TurnEvent } from "./turns";
import { readTranscript } from "./workers/transcript";
import { MAX_TRANSCRIPT, type VoiceResult } from "./voice";

const ctx = BACKGROUND_CONTEXT;
const MAX_PROMPT = 4000;

export const INSTRUCTIONS = `You are Jev, the orchestrator of a personal coding command center. Messages come from a desktop app or a small robot, often as speech transcripts. Each message starts with a tag such as [intent: project 0.92], the verdict of an intent classifier that already ran.

- Project work: call classify_project with the request. Band "spawn": call dispatch_worker with that project and cwd, and the user's request as the prompt (keep their words; add context from this conversation only when the request refers to it). Band "ask": ask which of the candidates they mean, in one short question. Band "escalate": say you could not tell which project.
- Use agent "pi" only when the user asks for pi; otherwise "claude".
- Status ("what's running?"): call list_sessions and answer from it.
- Anything else: answer briefly, or say what you can do.
- Messages starting with [worker event] are notes about workers you started. Use them when asked; they need no reply of their own.
- A worker that ended its turn with questions shows up as a [worker event] listing them. Questions that need the user's authority go to the user, in short spoken form; never answer those yourself. When the user answers, call answer_worker with their words. Questions you can settle from this conversation you may answer yourself.
- Progress ("how is it going?"): call session_status. It reads the worker's transcript and git without bothering it. Report the git facts as verified and the worker's own summary as its claim. Never message a running worker just to ask.
- cancel_worker stops a worker, only when the user asks.

Replies are spoken aloud: one or two short sentences, no markdown, no lists.`;

export type OrchestratorDeps = {
  storage: Storage;
  models: Models;
  model: { provider: string; modelId: string };
  getProjects: () => Project[];
  getSessions: () => Session[];
  decider: Decider;
  classifyIntent?: IntentClassifier;
  workers: Workers;
  /** Question batches and done summaries of workers. Defaults to a fresh in-memory one. */
  turns?: WorkerTurns;
  /** The daemon's own look at a worktree. Defaults to the real repository. */
  git?: (cwd: string) => GitFacts;
  /** How long a request waits for the answer before replying "still working". */
  waitMs?: number;
  logPath?: string;
};

export type Orchestrator = {
  handle(deviceKey: string, transcript: string, requestId?: string): Promise<VoiceResult>;
  onSession(e: ChangeEvent): void;
  /** A worker's turn ended with questions, a done summary, or neither. */
  onTurn(e: TurnEvent): void;
  close(): Promise<void>;
};

type Dispatch = { project: string; cwd: string; agent: WorkerId; id: string | null };

const text = (s: string) => ({ output: [{ type: "text" as const, text: s }] });

/** Tools the orchestrator gets. Hard gates (allowlist, prompt size) live here, never in the prompt. */
export function orchestratorTools(
  deps: Pick<OrchestratorDeps, "getProjects" | "getSessions" | "decider" | "workers"> & {
    turns: WorkerTurns;
    git: (cwd: string) => GitFacts;
  },
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
      const agent: WorkerId = args.agent ?? "claude";
      const name =
        `${WORKER_PREFIX}${project.name}-${String(api.taskId).replace(/\W/g, "").slice(-8)}`
          .replace(/[^\w.-]/g, "-")
          .slice(0, 64);
      const r = await deps.workers[agent].spawn(cwd, prompt, name);
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

  const findWorker = (id: string) => {
    const s = deps.getSessions().find((x) => x.id === id);
    if (!s || !isWorker(s)) throw new Error(`no das worker with session ${id}`);
    return s;
  };

  const sessionStatus = defineTool({
    name: "session_status",
    description:
      "Passive progress read of das workers (all, or one by session id): todos, last message, recent tool calls, hook events, open questions, and the diff. Never messages the worker.",
    parameters: Type.Object({ session: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => {
      const all = deps.getSessions().filter(isWorker);
      const picked = args.session ? all.filter((s) => s.id === args.session) : all;
      if (!picked.length) return text("No matching workers.");
      return text(
        picked
          .map((s) =>
            snapshotText({
              session: s,
              now: Date.now(),
              transcript: readTranscript(s.transcript),
              summary: deps.turns.summary(s.id),
              openBatch: deps.turns.store.open(s.id),
              git: deps.git(s.cwd),
            }),
          )
          .join("\n\n"),
      );
    },
  });

  const answerWorker = defineTool({
    name: "answer_worker",
    description:
      "Send the user's answers to a worker's open question batch, as one prompt. Only with answers the user gave (or you may settle yourself). One answer per batch.",
    parameters: Type.Object({
      session: Type.String({ description: "The worker's session id" }),
      answer: Type.String({ description: "The answers, numbered like the questions" }),
    }),
    // Not replay-safe: a call a crash interrupted is reported to the model, never run twice.
    execute: async (args) => {
      const s = findWorker(args.session);
      const answer = args.answer.trim();
      if (!answer || answer.length > MAX_PROMPT)
        throw new Error(`answer must be 1-${MAX_PROMPT} characters`);
      const store = deps.turns.store;
      const saved = store.answer(s.id, answer, "user, relayed by the orchestrator");
      if (!saved.ok) return text(`Not sent: ${saved.reason}.`);
      const prompt = `Answers to your questions:\n${answer}\n\nContinue.`;
      try {
        await deps.workers[s.agent].send(s.id, s.cwd, prompt);
      } catch (e) {
        // The answer stays persisted as answered, so it is never lost or sent twice by accident.
        return text(`Answer saved but delivery failed: ${String(e).slice(0, 200)}`);
      }
      store.markDelivered(s.id);
      return text("Delivered the answers to the worker.");
    },
  });

  const cancelWorker = defineTool({
    name: "cancel_worker",
    description: "Stop a das worker and close its open question batch. Only when the user asks.",
    parameters: Type.Object({ session: Type.String() }),
    execute: async (args) => {
      const s = findWorker(args.session);
      await deps.workers[s.agent].cancel(s.id);
      deps.turns.store.cancel(s.id);
      return text("Stopped the worker.");
    },
  });

  return [
    classifyProject,
    dispatchWorker,
    listSessions,
    listProjects,
    sessionStatus,
    answerWorker,
    cancelWorker,
  ];
}

const NOTIFY: Session["state"][] = ["done", "waiting", "error"];

export async function createOrchestrator(deps: OrchestratorDeps): Promise<Orchestrator> {
  const dispatched: Dispatch[] = [];
  const turns = deps.turns ?? new WorkerTurns(new ExchangeStore());
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "das",
      tools: orchestratorTools(
        { ...deps, turns, git: deps.git ?? ((cwd) => readGit(cwd)) },
        (d) => dispatched.push(d),
      ),
    }),
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
        const reason = settled.status === "unanswered" ? settled.reason : "";
        const detail = settled.status === "unanswered" ? settled.detail : undefined;
        log({ ...base, ...iMeta, outcome: "error", reason, detail });
        // The detail names the cause, such as a missing OpenRouter key, for the desktop to show.
        const why = typeof detail === "string" ? detail : reason;
        return {
          status: "error",
          text: `I couldn't answer that${why ? ` (${why.slice(0, 200)})` : ""}`,
        };
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
      // A finished turn with questions or a summary is told by onTurn, with its content.
      if (s.state === "done" && (turns.store.open(s.id) || turns.summary(s.id))) return;
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

    onTurn(e) {
      const s = deps.getSessions().find((x) => x.id === e.session);
      const name = s ? basename(s.worktree ?? s.cwd) : e.session;
      const body =
        e.kind === "questions"
          ? `asked ${e.questions.length} question${e.questions.length === 1 ? "" : "s"} (session ${e.session}): ${e.questions.map((q, n) => `${n + 1}. ${q}`).join(" ")}`
          : e.kind === "done"
            ? `reports it is done (its own summary, not verified; call session_status for the facts): ${e.summary.slice(0, 500)}`
            : `ended its turn with neither questions nor a done summary and needs attention: ${e.last.slice(0, 300)}`;
      void root
        .submit(
          {
            type: "write",
            requestId: `worker-turn:${e.session}:${e.kind}:${Date.now()}`,
            entry: {
              kind: "das.worker-turn",
              data: { ...e },
              model: [
                {
                  role: "user",
                  content: `[worker event] ${s?.agent ?? "claude"} worker ${name} ${body}`,
                  timestamp: Date.now(),
                },
              ],
            },
          },
          ctx,
        )
        .catch(() => {});
    },

    close: () => harness.close(ctx),
  };
}
