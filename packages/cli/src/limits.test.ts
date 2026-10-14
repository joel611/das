import { expect, test } from "bun:test";
import { LimitsTracker } from "./limits";

const T0 = 1_760_000_000_000;
const sec = (ms: number) => Math.round(ms / 1000);
const payload = (five?: [number, number], seven?: [number, number]) => ({
  session_id: "s",
  rate_limits: {
    ...(five ? { five_hour: { used_percentage: five[0], resets_at: sec(five[1]) } } : {}),
    ...(seven ? { seven_day: { used_percentage: seven[0], resets_at: sec(seven[1]) } } : {}),
  },
});
const H = 3_600_000;

test("reads both windows from a status line payload; resets_at seconds become ms", () => {
  const t = new LimitsTracker(() => T0);
  expect(t.summary()).toBeNull();
  expect(t.report(payload([23.5, T0 + 2 * H], [41.2, T0 + 72 * H]))).toBe(true);
  expect(t.summary()).toEqual({
    fiveHour: { usedPercent: 23.5, resetsAt: T0 + 2 * H },
    sevenDay: { usedPercent: 41.2, resetsAt: T0 + 72 * H },
    updatedAt: T0,
    source: "statusline",
  });
  expect(t.line()).toBe("5h 24% (2h00m) · 7d 41% (3d0h)");
});

test("payloads without rate_limits (API-key users, before the first response) change nothing", () => {
  const t = new LimitsTracker(() => T0);
  for (const p of [
    null,
    {},
    { rate_limits: null },
    { rate_limits: { five_hour: { used_percentage: "x" } } },
  ])
    expect(t.report(p)).toBe(false);
  expect(t.summary()).toBeNull();
  expect(t.line()).toBe("");
});

test("an idle session's older, lower copy never lowers the percent; a new window replaces it", () => {
  const t = new LimitsTracker(() => T0);
  t.report(payload([40, T0 + H]));
  t.report(payload([30, T0 + H])); // stale report from another session
  expect(t.summary()?.fiveHour?.usedPercent).toBe(40);
  t.report(payload([45, T0 + H]));
  expect(t.summary()?.fiveHour?.usedPercent).toBe(45);
  t.report(payload([2, T0 + 6 * H])); // next block
  expect(t.summary()?.fiveHour).toEqual({ usedPercent: 2, resetsAt: T0 + 6 * H });
  t.report(payload([90, T0 + H])); // late report for the old block
  expect(t.summary()?.fiveHour?.usedPercent).toBe(2);
});

test("a window past its reset is unknown; a missing window keeps the last value", () => {
  let now = T0;
  const t = new LimitsTracker(() => now);
  t.report(payload([50, T0 + H], [10, T0 + 48 * H]));
  t.report(payload(undefined, [11, T0 + 48 * H]));
  expect(t.summary()?.fiveHour?.usedPercent).toBe(50);
  now = T0 + 2 * H;
  expect(t.summary()).toEqual({
    fiveHour: null,
    sevenDay: { usedPercent: 11, resetsAt: T0 + 48 * H },
    updatedAt: T0,
    source: "statusline",
  });
  now = T0 + 49 * H;
  expect(t.summary()).toBeNull();
});
