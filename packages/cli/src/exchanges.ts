import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** pending: asked, unanswered. answered: answer persisted, not yet sent. delivered: sent to the worker (not proof it acted). */
export type BatchStatus = "pending" | "answered" | "delivered" | "cancelled";

export type Batch = {
  id: string;
  session: string;
  questions: string[];
  status: BatchStatus;
  askedAt: number;
  answer?: string;
  provenance?: string;
  answeredAt?: number;
};

/**
 * Question batches workers ended a turn with. A worker has at most one open batch, so correlation is by session.
 * Persisted to disk before anyone is told, so a daemon restart loses nothing; the worker's own transcript is the
 * source the daemon re-reads, so nothing here replays side effects.
 */
export class ExchangeStore {
  private batches: Batch[] = [];

  constructor(private path?: string) {
    if (path && existsSync(path)) {
      try {
        const rows = JSON.parse(readFileSync(path, "utf8"));
        if (Array.isArray(rows)) this.batches = rows;
      } catch {
        // a corrupt file starts empty rather than blocking the daemon
      }
    }
  }

  private save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.batches, null, 2));
    renameSync(tmp, this.path);
  }

  list(session?: string): Batch[] {
    return this.batches.filter((b) => !session || b.session === session);
  }

  /** The batch still waiting on an answer or a delivery. */
  open(session: string): Batch | undefined {
    return this.batches.findLast(
      (b) => b.session === session && (b.status === "pending" || b.status === "answered"),
    );
  }

  /** Records a batch. False when the same questions are already open (a re-read of the same turn). */
  openQuestions(session: string, questions: string[]): boolean {
    const cur = this.open(session);
    if (cur && cur.status === "pending" && cur.questions.join("\n") === questions.join("\n"))
      return false;
    // A newer turn supersedes an older batch the worker moved past.
    if (cur) cur.status = "cancelled";
    this.batches.push({
      id: crypto.randomUUID(),
      session,
      questions,
      status: "pending",
      askedAt: Date.now(),
    });
    this.save();
    return true;
  }

  answer(
    session: string,
    answer: string,
    provenance: string,
  ): { ok: true } | { ok: false; reason: string } {
    const b = this.open(session);
    if (!b) {
      const last = this.list(session).at(-1);
      return {
        ok: false,
        reason: last && last.status !== "cancelled" ? "already answered" : "no open question batch",
      };
    }
    if (b.status !== "pending") return { ok: false, reason: "already answered" };
    b.status = "answered";
    b.answer = answer;
    b.provenance = provenance;
    b.answeredAt = Date.now();
    this.save();
    return { ok: true };
  }

  markDelivered(session: string) {
    const b = this.open(session);
    if (b?.status !== "answered") return;
    b.status = "delivered";
    this.save();
  }

  cancel(session: string) {
    const b = this.open(session);
    if (!b) return;
    b.status = "cancelled";
    this.save();
  }
}
