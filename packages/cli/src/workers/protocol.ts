/** Appended to every worker's system prompt: workers never block on a tool, they end the turn with a tagged block. */
export const WORKER_RULE = `Work on your own as far as you can and keep your todo list current. When you need decisions from the user, end your turn with one numbered batch of questions inside <das-questions>...</das-questions>, and nothing after it. When you are finished, end your turn with <das-done>...</das-done> listing the outcome, changes, tests and blockers.`;

export type Turn =
  | { kind: "questions"; questions: string[] }
  | { kind: "done"; summary: string }
  | { kind: "none"; last: string };

const block = (text: string, tag: string) =>
  text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || null;

/** What a worker's last assistant message says about how its turn ended. */
export function parseTurn(text: string): Turn {
  const q = block(text, "das-questions");
  if (q) {
    const questions = q
      .split("\n")
      .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
      .filter(Boolean);
    if (questions.length) return { kind: "questions", questions };
  }
  const done = block(text, "das-done");
  if (done) return { kind: "done", summary: done };
  return { kind: "none", last: text.trim() };
}
