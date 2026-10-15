import type { Session, SessionState } from "./sessions";

export type Expression = "focused" | "worried" | "happy" | "sad" | "neutral";
export type Rgb = [number, number, number];
// Literal LED spec: the mod renders it as-is, so colours change without a mod rebuild.
export type Light =
  | { mode: "rainbow" }
  | { mode: "solid"; rgb: Rgb }
  | { mode: "blink"; rgb: Rgb; periodMs: number };
export type Display = { expression: Expression; headline: string; count: number; light: Light };

// Highest priority first.
const PRIORITY: SessionState[] = ["error", "waiting", "running", "done"];

const EXPRESSION: Record<SessionState, Expression> = {
  running: "focused",
  waiting: "worried",
  done: "happy",
  error: "sad",
  idle: "neutral",
};

const LIGHT: Record<SessionState, Light> = {
  running: { mode: "rainbow" },
  waiting: { mode: "solid", rgb: [255, 140, 0] },
  done: { mode: "solid", rgb: [0, 255, 0] },
  error: { mode: "solid", rgb: [255, 0, 0] },
  idle: { mode: "blink", rgb: [255, 255, 255], periodMs: 1000 },
};

export function computeDisplay(sessions: Pick<Session, "state">[]): Display {
  const state = PRIORITY.find((s) => sessions.some((x) => x.state === s)) ?? "idle";
  if (state === "idle")
    return { expression: EXPRESSION.idle, headline: "idle", count: 0, light: LIGHT.idle };
  const count = sessions.filter((x) => x.state === state).length;
  return {
    expression: EXPRESSION[state],
    headline: `${count} ${state}`,
    count,
    light: LIGHT[state],
  };
}
