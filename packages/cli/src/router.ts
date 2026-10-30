import { config, DEFAULT_CLASSIFIER_MODELS } from "./config";
import type { Project } from "./scanner";

export type Decision = {
  project: string | null;
  worktree?: string;
  confidence: number;
  alternatives: { project: string; p: number }[];
  raw?: unknown;
};

export type DecideContext = { previous?: string; candidates?: string[] };
export type Decider = (
  transcript: string,
  projects: Project[],
  context?: DecideContext,
) => Promise<Decision>;

export type Thresholds = { act: number; ask: number };
export const thresholds: Thresholds = {
  act: Number(process.env.ACT_THRESHOLD ?? 0.8),
  ask: Number(process.env.ASK_THRESHOLD ?? 0.4),
};

export type Band = "spawn" | "ask" | "escalate";

/** Pure: map a decision to an action band. Hard gates (allowlist, transcript) live in voice.ts. */
export function applyBands(
  d: Pick<Decision, "project" | "confidence">,
  t: Thresholds = thresholds,
): Band {
  if (d.project === null || d.confidence < t.ask) return "escalate";
  return d.confidence >= t.act ? "spawn" : "ask";
}

/** The classifier model, read live so a saved setting applies without a restart. */
const classifierModel = () =>
  config.classifierModel || DEFAULT_CLASSIFIER_MODELS[config.classifierProvider];
const URL_ = "https://openrouter.ai/api/alpha/decisions";
const LOW_WORKTREE_CONFIDENCE = 0.5;

const describe = (p: Project) => {
  const branches = p.worktrees.map((w) => w.branch).filter(Boolean);
  return `Project "${p.name}" at ${p.path}${branches.length ? `; branches: ${branches.join(", ")}` : ""}`;
};

const wtKey = (p: Project, i: number) =>
  `${p.name}@${p.worktrees[i].branch ?? p.worktrees[i].path}`;

/** Build the OpenRouter decisions request body. */
export function buildRequest(transcript: string, projects: Project[], context?: DecideContext) {
  const criteria: Record<string, string> = Object.fromEntries(
    projects.map((p) => [p.name, describe(p)]),
  );
  criteria.none = "Not a coding task for any listed project, or too unclear to tell which project";
  const state: Record<string, unknown> = { transcript };
  let instructions = "Pick the project this spoken coding request is for.";
  if (context?.previous) {
    state.previous_transcript = context.previous;
    state.clarification_options = context.candidates;
    instructions +=
      " The transcript answers a clarifying question about previous_transcript; choose among clarification_options.";
  }
  const questions: Record<string, unknown> = {
    project: { type: "choice", instructions, criteria },
  };
  const multi = projects.filter((p) => p.worktrees.length > 1);
  if (multi.length) {
    const wc: Record<string, string> = {};
    for (const p of multi)
      p.worktrees.forEach(
        (w, i) => (wc[wtKey(p, i)] = `Branch ${w.branch ?? "(detached)"} of ${p.name}`),
      );
    questions.worktree = {
      type: "choice",
      instructions:
        "If the request names or implies a specific branch/worktree, pick it; otherwise pick the main one.",
      criteria: wc,
    };
  }
  return { model: classifierModel(), state, questions };
}

type Answer = { choice: string; confidence: number; probabilities?: Record<string, number> };

/** Parse an OpenRouter decisions response into a Decision. Throws on malformed shape. */
export function parseResponse(json: any, projects: Project[]): Decision {
  const a: Answer | undefined = json?.answers?.project;
  if (!a || typeof a.choice !== "string" || typeof a.confidence !== "number")
    throw new Error("malformed decision response");
  const alternatives = Object.entries(a.probabilities ?? { [a.choice]: a.confidence })
    .filter(([name]) => name !== "none")
    .map(([project, p]) => ({ project, p }))
    .sort((x, y) => y.p - x.p);
  const project = a.choice === "none" ? null : a.choice;
  const d: Decision = { project, confidence: a.confidence, alternatives, raw: json };
  const w: Answer | undefined = json.answers.worktree;
  const p = projects.find((x) => x.name === project);
  if (p && w?.probabilities && p.worktrees.length > 1) {
    // best worktree belonging to the chosen project; low confidence -> primary (project.path)
    const best = p.worktrees
      .map((wt, i) => ({ wt, prob: w.probabilities![wtKey(p, i)] ?? 0 }))
      .sort((x, y) => y.prob - x.prob)[0];
    if (best.prob >= LOW_WORKTREE_CONFIDENCE) d.worktree = best.wt.path;
  }
  return d;
}

/**
 * Answer one decisions request. Only `typesafe/*` models on OpenRouter speak the decisions API; any
 * other model, and the ChatGPT subscription, answer the same questions through a chat completion.
 * Throws on a missing key or an HTTP error.
 */
async function postDecision(
  body: { model: string; state: unknown; questions: unknown },
  apiKey?: string,
  f?: typeof fetch,
) {
  if (!apiKey && !f && (config.classifierProvider === "openai" || !body.model.startsWith("typesafe/")))
    return (await import("./llm-decision")).llmDecision(body);
  f ??= fetch;
  const key = apiKey ?? config.openrouterKey;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const res = await f(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `decision API ${res.status}: ${json?.error?.message ?? json?.error?.code ?? "error"}`,
    );
  return json;
}

export function makeJevDecider(opts: { apiKey?: string; fetch?: typeof fetch } = {}): Decider {
  return async (transcript, projects, context) =>
    parseResponse(
      await postDecision(buildRequest(transcript, projects, context), opts.apiKey, opts.fetch),
      projects,
    );
}

export const jevDecider: Decider = makeJevDecider();

/** Step one of routing: what kind of request this is. Only `project` goes on to the project classifier. */
export type Intent = "project" | "status" | "other";
export type IntentDecision = { intent: Intent; confidence: number; raw?: unknown };
export type IntentClassifier = (transcript: string) => Promise<IntentDecision>;

/** Below this, a status/other verdict is not trusted and the request goes on to the project classifier. */
export const intentThreshold = Number(process.env.INTENT_THRESHOLD ?? 0.6);

const INTENTS: Record<Intent, string> = {
  project:
    "Asks to start, change, fix, build, review or investigate something in a code project or repository",
  status: "Asks what is running, or the state or progress of coding sessions, agents or workers",
  other: "Anything else: chit-chat, general knowledge, or too unclear to tell",
};

/** Build the OpenRouter decisions request body for the intent question. */
export function buildIntentRequest(transcript: string) {
  return {
    model: classifierModel(),
    state: { transcript },
    questions: {
      intent: {
        type: "choice",
        instructions:
          "Classify what this spoken or typed request to a coding command center asks for.",
        criteria: INTENTS,
      },
    },
  };
}

/** Parse an intent answer. Throws on malformed shape or an unknown choice. */
export function parseIntentResponse(json: any): IntentDecision {
  const a: Answer | undefined = json?.answers?.intent;
  if (
    !a ||
    typeof a.choice !== "string" ||
    typeof a.confidence !== "number" ||
    !(a.choice in INTENTS)
  )
    throw new Error("malformed intent response");
  return { intent: a.choice as Intent, confidence: a.confidence, raw: json };
}

export function makeJevIntentClassifier(
  opts: { apiKey?: string; fetch?: typeof fetch } = {},
): IntentClassifier {
  return async (transcript) =>
    parseIntentResponse(
      await postDecision(buildIntentRequest(transcript), opts.apiKey, opts.fetch),
    );
}

export const jevIntentClassifier: IntentClassifier = makeJevIntentClassifier();
