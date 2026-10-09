import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyBands, thresholds as defaultThresholds, type Band, type Decider, type Thresholds } from "./router";
import type { Project } from "./scanner";
import type { Spawner } from "./spawner";

export const MAX_TRANSCRIPT = 1000;
const PENDING_TTL_MS = 2 * 60_000;

export type VoiceResult = { status: "spawned" | "ask" | "escalate" | "error"; text: string; project?: string; sessionId?: string };

export type VoiceDeps = {
  decider: Decider;
  spawner: Spawner;
  getProjects: () => Project[];
  pending: Map<string, { previous: string; candidates: string[]; at: number }>;
  logPath?: string;
  thresholds?: Thresholds;
};

const log = (deps: VoiceDeps, entry: Record<string, unknown>) => {
  const path = deps.logPath ?? process.env.DECISIONS_LOG ?? "./data/decisions.jsonl";
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // logging must never break voice handling
  }
};

const SORRY = "Sorry, I didn't catch that";

export async function handleTranscript(deps: VoiceDeps, deviceKey: string, transcript: string): Promise<VoiceResult> {
  const text = (transcript ?? "").trim();
  const done = (r: VoiceResult, extra: Record<string, unknown> = {}) => {
    log(deps, { transcript: text.slice(0, MAX_TRANSCRIPT), device: deviceKey, outcome: r.status, ...extra });
    return r;
  };
  if (!text || text.length > MAX_TRANSCRIPT) {
    return done({ status: "escalate", text: SORRY }, { band: "escalate", reason: "invalid transcript" });
  }

  const projects = deps.getProjects();
  const p = deps.pending.get(deviceKey);
  deps.pending.delete(deviceKey);
  const ctx = p && Date.now() - p.at < PENDING_TTL_MS ? { previous: p.previous, candidates: p.candidates } : undefined;

  let d;
  try {
    d = await deps.decider(text, projects, ctx);
  } catch (e) {
    return done({ status: "error", text: e instanceof Error ? e.message : "decision failed" }, { error: String(e) });
  }
  const project = projects.find((x) => x.name === d.project);
  const band: Band = d.project !== null && !project ? "escalate" : applyBands(d, deps.thresholds ?? defaultThresholds);
  const meta = {
    choice: d.project,
    confidence: d.confidence,
    probabilities: Object.fromEntries(d.alternatives.map((a) => [a.project, a.p])),
    band,
    ...(d.project !== null && !project ? { reason: "project not in allowlist" } : {}),
  };

  if (band === "escalate" || !project) return done({ status: "escalate", text: SORRY }, meta);

  if (band === "ask") {
    const names = d.alternatives.filter((a) => projects.some((x) => x.name === a.project)).slice(0, 3).map((a) => a.project);
    if (names.length < 2) return done({ status: "escalate", text: SORRY }, { ...meta, band: "escalate" });
    deps.pending.set(deviceKey, { previous: ctx?.previous ?? text, candidates: names, at: Date.now() });
    return done({ status: "ask", text: `Which one, ${names.slice(0, -1).join(", ")} or ${names.at(-1)}?` }, meta);
  }

  const cwd = project.worktrees.some((w) => w.path === d.worktree) ? d.worktree! : project.path;
  // also used as the worktree folder/branch name: letters, digits, dot, underscore, dash only
  const name = `voice-${project.name}-${new Date().toISOString().slice(5, 16).replace(/\D/g, "")}`.replace(/[^\w.-]/g, "-").slice(0, 64);
  try {
    const r = await deps.spawner(cwd, text, name);
    return done({ status: "spawned", text: `Started in ${project.name}`, project: project.name, sessionId: r.id ?? undefined }, { ...meta, cwd, sessionId: r.id, stdout: r.stdout.slice(0, 500) });
  } catch (e) {
    const untrusted = /not trusted/i.test(String(e));
    return done({ status: "error", text: untrusted ? `Claude does not trust ${project.name} yet` : `Could not start in ${project.name}` }, { ...meta, error: String(e) });
  }
}
