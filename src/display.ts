import type { Session, SessionState } from "./sessions";

export type Expression = "focused" | "worried" | "happy" | "sad" | "neutral";
export type Display = { expression: Expression; headline: string; count: number };

// Highest priority first.
const PRIORITY: SessionState[] = ["error", "waiting", "running", "done"];

const EXPRESSION: Record<SessionState, Expression> = {
  running: "focused",
  waiting: "worried",
  done: "happy",
  error: "sad",
  idle: "neutral",
};

export function computeDisplay(sessions: Pick<Session, "state">[]): Display {
  const state = PRIORITY.find((s) => sessions.some((x) => x.state === s)) ?? "idle";
  if (state === "idle") return { expression: EXPRESSION.idle, headline: "idle", count: 0 };
  const count = sessions.filter((x) => x.state === state).length;
  return { expression: EXPRESSION[state], headline: `${count} ${state}`, count };
}
