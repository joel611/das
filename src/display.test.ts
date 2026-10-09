import { expect, test } from "bun:test";
import { computeDisplay } from "./display";

const s = (...states: any[]) => states.map((state) => ({ state }));

test("no sessions is idle/neutral", () => {
  expect(computeDisplay([])).toEqual({ expression: "neutral", headline: "idle", count: 0 });
});

test("only idle sessions is idle", () => {
  expect(computeDisplay(s("idle", "idle")).headline).toBe("idle");
});

test("running counts running sessions", () => {
  expect(computeDisplay(s("running", "running", "running", "done"))).toEqual({
    expression: "focused",
    headline: "3 running",
    count: 3,
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
  });
});
