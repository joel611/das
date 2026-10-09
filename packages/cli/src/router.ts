import { config } from "./config";
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

const MODEL = "typesafe/jev-1.13";
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
  return { model: MODEL, state, questions };
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

export function makeJevDecider(opts: { apiKey?: string; fetch?: typeof fetch } = {}): Decider {
  return async (transcript, projects, context) => {
    const apiKey = opts.apiKey ?? config.openrouterKey;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    const res = await (opts.fetch ?? fetch)(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest(transcript, projects, context)),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        `decision API ${res.status}: ${json?.error?.message ?? json?.error?.code ?? "error"}`,
      );
    return parseResponse(json, projects);
  };
}

export const jevDecider: Decider = makeJevDecider();
