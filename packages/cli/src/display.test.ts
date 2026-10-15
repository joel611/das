import { expect, test } from "bun:test";
import { computeDisplay } from "./display";

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

test("priority error > waiting > running > done > idle", () => {
  expect(computeDisplay(s("idle", "done")).expression).toBe("happy");
  expect(computeDisplay(s("done", "running")).expression).toBe("focused");
  expect(computeDisplay(s("running", "waiting")).expression).toBe("worried");
  expect(computeDisplay(s("waiting", "error", "running"))).toEqual({
    expression: "sad",
    headline: "1 error",
    count: 1,
    light: { mode: "solid", rgb: [255, 0, 0] },
  });
});

test("light per state", () => {
  expect(computeDisplay(s("waiting", "running")).light).toEqual({
    mode: "solid",
    rgb: [255, 140, 0],
  });
  expect(computeDisplay(s("done")).light).toEqual({ mode: "solid", rgb: [0, 255, 0] });
});
