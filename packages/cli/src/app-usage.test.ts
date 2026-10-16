import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { accountOrganization, FRESH_MS, historyFile, parseHistory, pollOnce } from "./app-usage";
import { LimitsTracker } from "./limits";

const T0 = 1_760_000_000_000;
const M = 60_000;
const H = 3_600_000;
const home = mkdtempSync(join(tmpdir(), "app-usage-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const v2 = (...samples: object[]) => JSON.stringify({ version: 2, samples });
const write = (text: string) => {
  mkdirSync(dirname(historyFile(home)), { recursive: true });
  writeFileSync(historyFile(home), text);
};

test("parseHistory: newest reading of version 1 and 2; unknown versions and junk are skipped", () => {
  expect(
    parseHistory(
      v2(
        { t: 1000, u: { fh: 10, sd: 5 } },
        { t: 3000, u: { fh: 30, sd: 6 } },
        { t: 2000, u: { fh: 20 } },
      ),
    ),
  ).toEqual({ at: 3000, fiveHour: 30, sevenDay: 6 });
  expect(parseHistory(JSON.stringify({ version: 1, samples: [{ t: 5, fh: 12, sd: 3 }] }))).toEqual({
    at: 5,
    fiveHour: 12,
    sevenDay: 3,
  });
  expect(parseHistory(JSON.stringify({ version: 3, samples: [{ t: 5, fh: 1 }] }))).toBeNull();
  expect(parseHistory("{")).toBeNull();
  expect(parseHistory(v2({ t: -1, u: { fh: 1 } }, { t: 9, u: { fh: "x", sd: true } }))).toBeNull();
  expect(parseHistory(v2({ t: 9, u: { fh: 250 } }))?.fiveHour).toBe(100);
});

test("parseHistory: readings of another organization are skipped", () => {
  const text = v2(
    { t: 1, org: "mine", u: { fh: 10 } },
    { t: 2, org: "other", u: { fh: 90 } },
    { t: 3, u: { fh: 20 } },
  );
  expect(parseHistory(text, "mine")?.fiveHour).toBe(20);
  expect(parseHistory(v2({ t: 2, org: "other", u: { fh: 90 } }), "mine")).toBeNull();
  expect(parseHistory(v2({ t: 2, org: "other", u: { fh: 90 } }))?.fiveHour).toBe(90);
});

test("accountOrganization reads .claude.json beside the home dir, or inside a custom config dir", async () => {
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { organizationUuid: "org-1" } }),
  );
  expect(await accountOrganization(join(home, ".claude"), home)).toBe("org-1");
  const other = mkdtempSync(join(home, "cfg-"));
  expect(await accountOrganization(other, home)).toBeUndefined();
  writeFileSync(
    join(other, ".claude.json"),
    JSON.stringify({ oauthAccount: { organizationUuid: "org-2" } }),
  );
  expect(await accountOrganization(other, home)).toBe("org-2");
});

const claudeDir = () => join(home, ".claude");

test("pollOnce: a fresh reading shows percent with no reset time when nothing else is known", async () => {
  write(v2({ t: T0 - 5 * M, u: { fh: 40, sd: 12 } }));
  const limits = new LimitsTracker(() => T0);
  expect(await pollOnce({ limits, claudeDir: claudeDir(), home, now: () => T0 })).toBe(true);
  expect(limits.summary()?.fiveHour).toMatchObject({
    usedPercent: 40,
    resetsAt: null,
    source: "app",
  });
  expect(limits.summary()?.sevenDay).toMatchObject({
    usedPercent: 12,
    resetsAt: null,
    source: "app",
  });
});

test("pollOnce: borrows the reset time of a window already known, and only raises it", async () => {
  const limits = new LimitsTracker(() => T0);
  limits.report(
    { rate_limits: { five_hour: { used_percentage: 30, resets_at: (T0 + 2 * H) / 1000 } } },
    "api",
  );
  write(v2({ t: T0 + M, u: { fh: 45 } }));
  const now = T0 + 10 * M;
  expect(await pollOnce({ limits, claudeDir: claudeDir(), home, now: () => now })).toBe(true);
  expect(limits.summary(now)?.fiveHour).toMatchObject({
    usedPercent: 45,
    resetsAt: T0 + 2 * H,
    source: "app",
  });
});

test("pollOnce: ignores old or older-than-ours readings", async () => {
  const limits = new LimitsTracker(() => T0);
  limits.report(
    { rate_limits: { five_hour: { used_percentage: 30, resets_at: (T0 + 2 * H) / 1000 } } },
    "api",
  );
  write(v2({ t: T0 - M, u: { fh: 80 } }));
  expect(await pollOnce({ limits, claudeDir: claudeDir(), home, now: () => T0 + M })).toBe(false);
  const later = T0 + 10 * M;
  expect(await pollOnce({ limits, claudeDir: claudeDir(), home, now: () => later })).toBe(false);
  expect(limits.summary(later)?.fiveHour?.usedPercent).toBe(30);
  const bare = new LimitsTracker(() => T0 + FRESH_MS + M);
  expect(
    await pollOnce({ limits: bare, claudeDir: claudeDir(), home, now: () => T0 + FRESH_MS + M }),
  ).toBe(false);
  rmSync(historyFile(home));
  expect(await pollOnce({ limits: bare, claudeDir: claudeDir(), home, now: () => T0 })).toBe(false);
});

test("a percent without a reset time is only accepted from the app file", () => {
  const t = new LimitsTracker(() => T0);
  const p = { rate_limits: { five_hour: { used_percentage: 40, resets_at: null } } };
  expect(t.report(p, "api")).toBe(false);
  expect(t.report(p, "app")).toBe(true);
  t.report(
    { rate_limits: { five_hour: { used_percentage: 41, resets_at: (T0 + H) / 1000 } } },
    "api",
  );
  expect(t.summary()?.fiveHour).toMatchObject({ usedPercent: 41, resetsAt: T0 + H });
  expect(t.report(p, "app")).toBe(false);
});
