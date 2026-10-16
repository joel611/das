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

// Beep played when a session enters a state; the mod renders it with audio.tone.
export type Sound = { hz: number; ms: number };
const SOUND: Partial<Record<SessionState, Sound>> = {
  waiting: { hz: 660, ms: 200 },
  done: { hz: 880, ms: 150 },
  error: { hz: 220, ms: 400 },
};

/** The sound for a session moving from `prev` (undefined if new) to `next`; none if the state is unchanged. */
export function soundFor(prev: SessionState | undefined, next: SessionState): Sound | null {
  return prev === next ? null : (SOUND[next] ?? null);
}
