import { describe, expect, test } from "bun:test";
import { parseTurn, WORKER_RULE } from "./protocol";

describe("parseTurn", () => {
  test("questions block becomes a numbered list", () => {
    const t = parseTurn("Stuck.\n<das-questions>\n1. Use sqlite?\n2) Which port?\n</das-questions>");
    expect(t).toEqual({ kind: "questions", questions: ["Use sqlite?", "Which port?"] });
  });
  test("done block keeps its body", () => {
    const t = parseTurn("<das-done>\nOutcome: ok\nTests: pass\n</das-done>");
    expect(t).toEqual({ kind: "done", summary: "Outcome: ok\nTests: pass" });
  });
  test("questions win when both appear", () => {
    expect(parseTurn("<das-done>x</das-done><das-questions>1. q</das-questions>").kind).toBe(
      "questions",
    );
  });
  test("neither block is flagged", () => {
    expect(parseTurn("just text")).toEqual({ kind: "none", last: "just text" });
    expect(parseTurn("<das-questions>   </das-questions>").kind).toBe("none");
  });
  test("rule names both tags", () => {
    expect(WORKER_RULE).toContain("<das-questions>");
    expect(WORKER_RULE).toContain("<das-done>");
  });
});
