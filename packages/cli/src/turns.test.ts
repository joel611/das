import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExchangeStore } from "./exchanges";
import { WorkerTurns } from "./turns";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const transcript = (text: string) => {
  const d = mkdtempSync(join(tmpdir(), "das-turns-"));
  dirs.push(d);
  const p = join(d, "t.jsonl");
  writeFileSync(
    p,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  );
  return p;
};
const worker = { cwd: "/p/.claude/worktrees/orch-alpha-1" };
const stop = (id: string, text: string, cwd = worker.cwd) => ({
  session_id: id,
  cwd,
  transcript_path: transcript(text),
});

test("questions are persisted and reported once", () => {
  const t = new WorkerTurns(new ExchangeStore());
  const text = "<das-questions>1. sqlite?</das-questions>";
  expect(t.handleStop(stop("s1", text))).toEqual({
    kind: "questions",
    session: "s1",
    questions: ["sqlite?"],
  });
  expect(t.store.open("s1")?.questions).toEqual(["sqlite?"]);
  // the same turn re-read (e.g. after a restart) is not a new event
  expect(t.handleStop(stop("s1", text))).toBeNull();
});

test("done summary is kept apart from questions", () => {
  const t = new WorkerTurns(new ExchangeStore());
  expect(t.handleStop(stop("s1", "<das-done>shipped</das-done>"))).toEqual({
    kind: "done",
    session: "s1",
    summary: "shipped",
  });
  expect(t.summary("s1")).toBe("shipped");
  expect(t.store.open("s1")).toBeUndefined();
});

test("a turn with neither block needs attention and forwards the last message", () => {
  const t = new WorkerTurns(new ExchangeStore());
  expect(t.handleStop(stop("s1", "I am confused"))).toEqual({
    kind: "attention",
    session: "s1",
    last: "I am confused",
  });
});

test("sessions that are not das workers are ignored", () => {
  const t = new WorkerTurns(new ExchangeStore());
  expect(t.handleStop(stop("s1", "hi", "/p/other"))).toBeNull();
});

test("restart: open batch is recovered from the transcript without a new event", () => {
  const store = new ExchangeStore();
  store.openQuestions("s1", ["sqlite?"]);
  const t = new WorkerTurns(store);
  expect(t.handleStop(stop("s1", "<das-questions>1. sqlite?</das-questions>"))).toBeNull();
  expect(store.open("s1")?.status).toBe("pending");
});
