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
    fiveHour: { usedPercent: 23.5, resetsAt: T0 + 2 * H, observedAt: T0, source: "statusline" },
    sevenDay: { usedPercent: 41.2, resetsAt: T0 + 72 * H, observedAt: T0, source: "statusline" },
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
  let now = T0;
  const t = new LimitsTracker(() => now);
  t.report(payload([40, T0 + H]));
  t.report(payload([30, T0 + H]));
  expect(t.summary()?.fiveHour?.usedPercent).toBe(40);
  t.report(payload([45, T0 + H]));
  expect(t.summary()?.fiveHour?.usedPercent).toBe(45);
  now = T0 + 2 * H;
  t.report(payload([2, T0 + 6 * H]));
  expect(t.summary()?.fiveHour).toMatchObject({ usedPercent: 2, resetsAt: T0 + 6 * H });
  t.report(payload([90, T0 + H]));
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
    sevenDay: { usedPercent: 11, resetsAt: T0 + 48 * H, observedAt: T0, source: "statusline" },
    updatedAt: T0,
    source: "statusline",
  });
  now = T0 + 49 * H;
  expect(t.summary()).toBeNull();
});

test("a window is the same one within a small reset-time tolerance (rounding, jitter between sources)", () => {
  let now = T0;
  const t = new LimitsTracker(() => now);
  t.report(payload([20, T0 + 2 * H]));
  expect(t.report(payload([30, T0 + 2 * H + 1000]))).toBe(true);
  expect(t.summary()?.fiveHour).toMatchObject({ usedPercent: 30, resetsAt: T0 + 2 * H });
  now = T0 + 3 * H;
  t.report(payload([5, T0 + 7 * H]));
  expect(t.summary()?.fiveHour).toMatchObject({ usedPercent: 5, resetsAt: T0 + 7 * H });
});

test("an older window is rejected without refreshing updatedAt", () => {
  let now = T0;
  const t = new LimitsTracker(() => now);
  t.report(payload([20, T0 + 4 * H]));
  now = T0 + 1000;
  expect(t.report(payload([99, T0 + 2 * H]))).toBe(false);
  expect(t.summary()?.updatedAt).toBe(T0);
  expect(t.summary()?.fiveHour?.usedPercent).toBe(20);
});

test("implausible reports (reset past, beyond the window length) and out-of-range percents are bounded", () => {
  const t = new LimitsTracker(() => T0);
  expect(t.report(payload([100, T0 + 3000 * H], [100, T0 + 3000 * H]))).toBe(false);
  expect(t.report(payload([100, T0 - H]))).toBe(false);
  expect(t.summary()).toBeNull();
  t.report(payload([250, T0 + H]));
  expect(t.summary()?.fiveHour?.usedPercent).toBe(100);
});

test("a repeat of the same value doesn't count as fresh: observedAt and statusLineAt stay", () => {
  let now = T0;
  const t = new LimitsTracker(() => now);
  t.report(payload([40, T0 + H]));
  now = T0 + 10 * 60_000;
  expect(t.report(payload([40, T0 + H]))).toBe(true);
  expect(t.statusLineAt).toBe(T0);
  expect(t.summary()?.fiveHour?.observedAt).toBe(T0);
  t.report(payload([41, T0 + H]));
  expect(t.statusLineAt).toBe(now);
  expect(t.summary()?.fiveHour?.observedAt).toBe(now);
});

test("an idle account (0%, no reset) shows as 0% until a real window replaces it; it never replaces a live one", () => {
  let now = T0;
  const t = new LimitsTracker(() => now);
  const idle = { rate_limits: { five_hour: { used_percentage: 0, resets_at: null } } };
  expect(t.report(idle, "api")).toBe(true);
  expect(t.summary()?.fiveHour).toMatchObject({ usedPercent: 0, resetsAt: null, source: "api" });
  expect(t.line()).toBe("5h 0%");
  t.report(payload([3, T0 + 4 * H]));
  expect(t.summary()?.fiveHour).toMatchObject({ usedPercent: 3, resetsAt: T0 + 4 * H });
  expect(t.report(idle, "api")).toBe(false);
  expect(t.summary()?.fiveHour?.usedPercent).toBe(3);
  expect(t.report({ rate_limits: { seven_day: { used_percentage: 50, resets_at: null } } })).toBe(
    false,
  );
});
