import { basename } from "node:path";
import type { ExchangeStore } from "./exchanges";
import type { HookPayload, Session } from "./sessions";
import { parseTurn } from "./workers/protocol";
import { readTranscript } from "./workers/transcript";

/** Worktree names of dispatched workers start with this, so their hook events can be told apart. */
export const WORKER_PREFIX = "orch-";

export const isWorkerPath = (...paths: (string | null | undefined)[]) =>
  paths.some((p) => !!p && basename(p).startsWith(WORKER_PREFIX));

export const isWorker = (s: Pick<Session, "cwd" | "worktree">) => isWorkerPath(s.cwd, s.worktree);

export type TurnEvent =
  | { kind: "questions"; session: string; questions: string[] }
  | { kind: "done"; session: string; summary: string }
  | { kind: "attention"; session: string; last: string };

/**
 * What a das worker's finished turn means. On `Stop` it reads the last assistant message from the transcript,
 * persists a question batch before anyone is told, and keeps the worker's own done summary.
 * Re-reading a turn it already knows (the batch is also in the transcript after a restart) yields no event.
 */
export class WorkerTurns {
  private summaries = new Map<string, string>();

  constructor(readonly store: ExchangeStore) {}

  /** The worker-reported `<das-done>` summary, never the daemon-verified result. */
  summary(session: string) {
    return this.summaries.get(session);
  }

  handleStop(p: HookPayload): TurnEvent | null {
    if (!p.session_id || !isWorkerPath(p.cwd)) return null;
    const session = p.session_id;
    const turn = parseTurn(readTranscript(p.transcript_path).lastAssistant);
    this.summaries.delete(session);
    switch (turn.kind) {
      case "questions":
        return this.store.openQuestions(session, turn.questions, {
          agent: p.agent === "pi" ? "pi" : "claude",
          cwd: p.cwd!,
        })
          ? { kind: "questions", session, questions: turn.questions }
          : null;
      case "done":
        this.summaries.set(session, turn.summary);
        return { kind: "done", session, summary: turn.summary };
      case "none":
        return { kind: "attention", session, last: turn.last };
    }
  }
}
