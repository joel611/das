import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsTracker } from "./limits";
import { keychainServices, pollOnce, readClaudeToken, toRateLimits, USAGE_URL } from "./usage-api";

const T0 = Date.parse("2026-10-14T20:00:00Z");
const M = 60_000;

test("toRateLimits reads five_hour / seven_day (utilization 0-100, ISO resets_at)", () => {
  expect(
    toRateLimits({
      five_hour: { utilization: 33, resets_at: "2026-10-14T22:00:00.528743+00:00" },
      seven_day: { utilization: 12.5, resets_at: "2026-10-18T07:00:00+00:00" },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    }),
  ).toEqual({
    five_hour: { used_percentage: 33, resets_at: Date.parse("2026-10-14T22:00:01Z") / 1000 },
    seven_day: { used_percentage: 12.5, resets_at: Date.parse("2026-10-18T07:00:00Z") / 1000 },
  });
});

test("toRateLimits also reads a limits array, and nothing usable is null", () => {
  expect(
    toRateLimits({
      five_hour: null,
      limits: [
        { kind: "session", percent: 40, resets_at: "2026-10-14T22:00:00Z" },
        { kind: "weekly_all", percent: 20, resets_at: "2026-10-18T07:00:00Z" },
        { kind: "weekly_scoped", percent: 90, resets_at: "2026-10-18T07:00:00Z" },
      ],
    }),
  ).toEqual({
    five_hour: { used_percentage: 40, resets_at: Date.parse("2026-10-14T22:00:00Z") / 1000 },
    seven_day: { used_percentage: 20, resets_at: Date.parse("2026-10-18T07:00:00Z") / 1000 },
  });
  for (const b of [null, {}, { five_hour: { utilization: "x" } }])
    expect(toRateLimits(b)).toBeNull();
});

test("token: env first, then .credentials.json; an expired one is skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "creds-"));
  expect(await readClaudeToken(dir, T0, { CLAUDE_CODE_OAUTH_TOKEN: "env-tok" })).toBe("env-tok");
  if (process.platform === "darwin") return; // the Keychain is consulted before the file there
  expect(await readClaudeToken(dir, T0, {})).toBeNull();
  const creds = (expiresAt: number) =>
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "file-tok", expiresAt } }),
    );
  creds(T0 + M);
  expect(await readClaudeToken(dir, T0, {})).toBe("file-tok");
  creds(T0 - M);
  expect(await readClaudeToken(dir, T0, {})).toBeNull();
});

const setup = (respond: () => Response) => {
  let now = T0;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const limits = new LimitsTracker(() => now);
  const o = {
    limits,
    claudeDir: "/nope",
    enabled: () => true,
    intervalMs: 5 * M,
    now: () => now,
    readToken: async () => "tok",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return respond();
    }) as unknown as typeof fetch,
  };
  return { o, limits, calls, failures: { n: 0 }, advance: (ms: number) => (now += ms) };
};
const ok = () =>
  Response.json({ five_hour: { utilization: 33, resets_at: new Date(T0 + 60 * M).toISOString() } });

test("poll: reports limits with source api, sends the token and beta header", async () => {
  const { o, limits, calls, failures } = setup(ok);
  expect(await pollOnce(o, failures)).toBe(5 * M);
  expect(calls[0].url).toBe(USAGE_URL);
  expect(calls[0].headers.authorization).toBe("Bearer tok");
  expect(calls[0].headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  expect(limits.summary()).toMatchObject({ fiveHour: { usedPercent: 33 }, source: "api" });
});

test("poll: skipped while off or while the status line is fresh", async () => {
  const { o, limits, calls, failures, advance } = setup(ok);
  await pollOnce({ ...o, enabled: () => false }, failures);
  expect(calls).toHaveLength(0);
  limits.report({
    rate_limits: { five_hour: { used_percentage: 10, resets_at: (T0 + 60 * M) / 1000 } },
  });
  advance(4 * M);
  await pollOnce(o, failures);
  expect(calls).toHaveLength(0);
  advance(2 * M);
  await pollOnce(o, failures);
  expect(calls).toHaveLength(1);
});

test("poll: backs off on 429 (honouring retry-after) and on network errors, then recovers", async () => {
  let res: () => Response = () =>
    new Response("", { status: 429, headers: { "retry-after": "3600" } });
  const s = setup(() => res());
  expect(await pollOnce(s.o, s.failures)).toBe(60 * M);
  res = () => new Response("", { status: 500 });
  expect(await pollOnce(s.o, s.failures)).toBe(5 * M * 4);
  res = () => {
    throw new Error("offline");
  };
  expect(await pollOnce(s.o, s.failures)).toBe(5 * M * 8);
  res = ok;
  expect(await pollOnce(s.o, s.failures)).toBe(5 * M);
  expect(s.failures.n).toBe(0);
});

test("keychain item is scoped by config dir unless it is ~/.claude", () => {
  expect(keychainServices("/h/.claude", "/h")).toEqual(["Claude Code-credentials"]);
  const [scoped, base] = keychainServices("/h/.claude-work", "/h");
  expect(scoped).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  expect(base).toBe("Claude Code-credentials");
});
