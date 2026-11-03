import type { Batch } from "./exchanges";
import type { Session } from "./sessions";
import type { TranscriptSnapshot } from "./workers/transcript";

export type GitFacts = { diffStat: string; commits: string };

/** The daemon's own look at a worktree: not the worker's claims. */
export function readGit(cwd: string): GitFacts {
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  };
  return { diffStat: run("diff", "--stat", "HEAD"), commits: run("log", "--oneline", "-5") };
}

export type SnapshotInput = {
  session: Session;
  now: number;
  transcript: TranscriptSnapshot;
  /** The worker's own `<das-done>` text. */
  summary?: string;
  openBatch?: Pick<Batch, "questions" | "status">;
  git: GitFacts;
};

const age = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s ago`;

/** A passive progress read of a worker, built from its transcript, hook events and git. It never messages the worker. */
export function snapshotText(i: SnapshotInput): string {
  const { session: s, transcript: t } = i;
  const lines = [`${s.agent} worker in ${s.project ?? "unknown"} (${s.branch ?? "no branch"}): ${s.state}${s.detail ? `, ${s.detail}` : ""}`];
  if (i.openBatch)
    lines.push(
      `open questions (${i.openBatch.status}):`,
      ...i.openBatch.questions.map((q, n) => `${n + 1}. ${q}`),
    );
  lines.push("worker-reported (its own words, unverified):");
  lines.push(`  todos: ${t.todos.map((x) => `[${x.status}] ${x.content}`).join("; ") || "none"}`);
  lines.push(`  last message: ${t.lastAssistant.slice(0, 300) || "none"}`);
  if (i.summary) lines.push(`  done summary: ${i.summary.slice(0, 500)}`);
  lines.push(`  recent tools: ${t.recentTools.map((x) => x.name).join(", ") || "none"}`);
  lines.push(
    `recent hook events: ${s.events.map((e) => `${e.event} ${age(i.now - e.at)}`).join(", ") || "none"}`,
  );
  lines.push("daemon-verified (git):");
  lines.push(`  ${i.git.diffStat || "no uncommitted changes"}`);
  if (i.git.commits) lines.push(`  recent commits:\n${i.git.commits}`);
  return lines.join("\n");
}
