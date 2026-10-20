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
const PRIORITY: SessionState[] = ["error", "running", "waiting", "done"];

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

/** Neck pose in degrees: yaw positive = left, pitch positive = up. */
export type Servo = { yaw: number; pitch: number };

/** A direct, one-off command to a single device, from the desktop app. */
export type Signal = {
  display?: Display;
  sound?: Sound;
  light?: Light;
  servo?: Servo;
  camera?: boolean;
  /** Text for the device to speak through its TTS. */
  say?: string;
};

const STATES: SessionState[] = ["running", "waiting", "done", "error", "idle"];

const isRgb = (v: unknown): v is Rgb =>
  Array.isArray(v) &&
  v.length === 3 &&
  v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255);

function parseLight(v: unknown): Light | null {
  const l = (v ?? {}) as { mode?: unknown; rgb?: unknown; periodMs?: unknown };
  if (l.mode === "rainbow") return { mode: "rainbow" };
  if (l.mode === "solid" && isRgb(l.rgb)) return { mode: "solid", rgb: l.rgb };
  if (
    l.mode === "blink" &&
    isRgb(l.rgb) &&
    typeof l.periodMs === "number" &&
    l.periodMs >= 100 &&
    l.periodMs <= 5000
  )
    return { mode: "blink", rgb: l.rgb, periodMs: l.periodMs };
  return null;
}

/** Validate a signal request body: `state` renders as the Display that state would show; the rest are bounded. Null if invalid or empty. */
export function parseSignal(body: unknown): Signal | null {
  const b = (body ?? {}) as {
    state?: unknown;
    sound?: { hz?: unknown; ms?: unknown };
    light?: unknown;
    servo?: { yaw?: unknown; pitch?: unknown };
    camera?: unknown;
    say?: unknown;
  };
  const signal: Signal = {};
  if (b.state !== undefined) {
    if (!STATES.includes(b.state as SessionState)) return null;
    signal.display = computeDisplay([{ state: b.state as SessionState }]);
  }
  if (b.sound !== undefined) {
    const { hz, ms } = b.sound ?? {};
    if (typeof hz !== "number" || typeof ms !== "number") return null;
    if (hz < 100 || hz > 5000 || ms < 1 || ms > 2000) return null;
    signal.sound = { hz, ms };
  }
  if (b.light !== undefined) {
    const light = parseLight(b.light);
    if (!light) return null;
    signal.light = light;
  }
  if (b.servo !== undefined) {
    const { yaw, pitch } = b.servo ?? {};
    if (typeof yaw !== "number" || typeof pitch !== "number") return null;
    if (yaw < -90 || yaw > 90 || pitch < -30 || pitch > 30) return null;
    signal.servo = { yaw, pitch };
  }
  if (b.camera !== undefined) {
    if (typeof b.camera !== "boolean") return null;
    signal.camera = b.camera;
  }
  if (b.say !== undefined) {
    if (typeof b.say !== "string") return null;
    const say = b.say.trim();
    if (!say || say.length > 200) return null;
    signal.say = say;
  }
  return Object.keys(signal).length ? signal : null;
}
