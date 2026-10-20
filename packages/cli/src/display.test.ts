import { expect, test } from "bun:test";
import { computeDisplay, parseSignal, soundFor } from "./display";

const s = (...states: any[]) => states.map((state) => ({ state }));

test("no sessions is idle/neutral", () => {
  expect(computeDisplay([])).toEqual({
    expression: "neutral",
    headline: "idle",
    count: 0,
    light: { mode: "blink", rgb: [255, 255, 255], periodMs: 1000 },
  });
});

test("only idle sessions is idle", () => {
  expect(computeDisplay(s("idle", "idle")).headline).toBe("idle");
});

test("running counts running sessions", () => {
  expect(computeDisplay(s("running", "running", "running", "done"))).toEqual({
    expression: "focused",
    headline: "3 running",
    count: 3,
    light: { mode: "rainbow" },
  });
});

test("priority error > running > waiting > done > idle", () => {
  expect(computeDisplay(s("idle", "done")).expression).toBe("happy");
  expect(computeDisplay(s("done", "running")).expression).toBe("focused");
  expect(computeDisplay(s("running", "waiting")).expression).toBe("focused");
  expect(computeDisplay(s("waiting", "error", "running"))).toEqual({
    expression: "sad",
    headline: "1 error",
    count: 1,
    light: { mode: "solid", rgb: [255, 0, 0] },
  });
});

test("light per state", () => {
  expect(computeDisplay(s("waiting", "done")).light).toEqual({
    mode: "solid",
    rgb: [255, 140, 0],
  });
  expect(computeDisplay(s("done")).light).toEqual({ mode: "solid", rgb: [0, 255, 0] });
});

test("soundFor beeps only when entering waiting, done or error", () => {
  expect(soundFor(undefined, "done")).toEqual({ hz: 880, ms: 150 });
  expect(soundFor("running", "error")).toEqual({ hz: 220, ms: 400 });
  expect(soundFor("done", "done")).toBeNull();
  expect(soundFor("done", "running")).toBeNull();
});

test("parseSignal accepts light, servo and camera and rejects out-of-range values", () => {
  expect(parseSignal({ light: { mode: "solid", rgb: [1, 2, 3] } })?.light).toEqual({
    mode: "solid",
    rgb: [1, 2, 3],
  });
  expect(parseSignal({ servo: { yaw: 10, pitch: 45 }, camera: true })).toEqual({
    servo: { yaw: 10, pitch: 45 },
    camera: true,
  });
  expect(parseSignal({ light: { mode: "solid", rgb: [1, 2, 300] } })).toBeNull();
  expect(parseSignal({ light: { mode: "blink", rgb: [0, 0, 0], periodMs: 5 } })).toBeNull();
  expect(parseSignal({ servo: { yaw: 130, pitch: 45 } })).toBeNull();
  expect(parseSignal({ servo: { yaw: 0, pitch: 0 } })).toBeNull();
  expect(parseSignal({ camera: "yes" })).toBeNull();
  expect(parseSignal({})).toBeNull();
});

test("parseSignal validates say", () => {
  expect(parseSignal({ say: " hello " })?.say).toBe("hello");
  expect(parseSignal({ say: "" })).toBeNull();
  expect(parseSignal({ say: "x".repeat(201) })).toBeNull();
  expect(parseSignal({ say: 5 })).toBeNull();
});
