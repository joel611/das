import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LimitsTracker } from "./limits";

/**
 * Opt-in fallback for plan limits while no Claude session is running (so no status line reports them):
 * poll the endpoint Claude Code's own /usage reads, `GET api.anthropic.com/api/oauth/usage`, with the
 * Claude Code login token. Undocumented and rate limited, so it runs at most every few minutes, only when
 * the status line has gone quiet, backs off on errors, and never refreshes or writes the token.
 *
 * Token: $CLAUDE_CODE_OAUTH_TOKEN, else the macOS Keychain item "Claude Code-credentials" (with a
 * "-<sha256(dir)[:8]>" suffix when CLAUDE_CONFIG_DIR points elsewhere, as Claude Code names it), else
 * `<claude dir>/.credentials.json` (both hold `claudeAiOauth.{accessToken, expiresAt}`).
 */

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const POLL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

type Creds = { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };

function tokenFrom(text: string, now: number): string | null {
  try {
    const o = (JSON.parse(text) as Creds).claudeAiOauth;
    if (typeof o?.accessToken !== "string" || !o.accessToken) return null;
    // Claude Code refreshes its own token; an expired one is skipped until it has.
    if (typeof o.expiresAt === "number" && o.expiresAt <= now) return null;
    return o.accessToken;
  } catch {
    return null;
  }
}

/** Keychain service names to try: Claude Code scopes the item by config dir when it is not ~/.claude. */
export function keychainServices(claudeDir: string, home = homedir()): string[] {
  const base = "Claude Code-credentials";
  if (claudeDir === join(home, ".claude")) return [base];
  const hash = createHash("sha256").update(claudeDir).digest("hex").slice(0, 8);
  return [`${base}-${hash}`, base];
}

export async function readClaudeToken(
  claudeDir: string,
  now = Date.now(),
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;
  if (process.platform === "darwin") {
    for (const service of keychainServices(claudeDir)) {
      const p = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) === 0) {
        const t = tokenFrom(out.trim(), now);
        if (t) return t;
      }
    }
  }
  const file = await readFile(join(claudeDir, ".credentials.json"), "utf8").catch(() => null);
  return file ? tokenFrom(file, now) : null;
}

const epochSec = (v: unknown) => {
  const ms = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v * 1000 : NaN;
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
};

/**
 * The API response as a status line `rate_limits` object, so LimitsTracker treats both sources alike.
 * Reads `five_hour` / `seven_day` ({utilization 0-100, resets_at ISO}), or a `limits` array of
 * {kind: "session" | "weekly_all", percent, resets_at} where an account gets that shape instead.
 */
export function toRateLimits(body: unknown): Record<string, unknown> | null {
  const b = body as Record<string, any> | null;
  if (!b || typeof b !== "object") return null;
  const win = (pct: unknown, reset: unknown) => {
    const resets_at = epochSec(reset);
    return typeof pct === "number" && resets_at ? { used_percentage: pct, resets_at } : undefined;
  };
  const out: Record<string, unknown> = {};
  const five = win(b.five_hour?.utilization, b.five_hour?.resets_at);
  const seven = win(b.seven_day?.utilization, b.seven_day?.resets_at);
  if (five) out.five_hour = five;
  if (seven) out.seven_day = seven;
  if (Array.isArray(b.limits)) {
    for (const l of b.limits) {
      const w = win(l?.percent ?? l?.utilization, l?.resets_at);
      if (!w) continue;
      if (l.kind === "session" && !out.five_hour) out.five_hour = w;
      if (l.kind === "weekly_all" && !out.seven_day) out.seven_day = w;
    }
  }
  return Object.keys(out).length ? out : null;
}

type PollOpts = {
  limits: LimitsTracker;
  claudeDir: string;
  enabled: () => boolean;
  intervalMs?: number;
  fetch?: typeof fetch;
  readToken?: () => Promise<string | null>;
  now?: () => number;
  log?: (msg: string) => void;
};

/** One poll; returns the delay before the next. Exported for tests. */
export async function pollOnce(o: PollOpts, failures: { n: number }): Promise<number> {
  const interval = o.intervalMs ?? POLL_MS;
  const now = o.now?.() ?? Date.now();
  if (!o.enabled()) return interval;
  // A status line report within the interval is fresher than this would be.
  if (now - o.limits.statusLineAt < interval) return interval;
  const backoff = () => Math.min(MAX_BACKOFF_MS, interval * 2 ** ++failures.n);
  const token = await (o.readToken ?? (() => readClaudeToken(o.claudeDir)))();
  if (!token) {
    o.log?.("usage api: no Claude Code login token found (or it has expired)");
    return interval;
  }
  try {
    const res = await (o.fetch ?? fetch)(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "das",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after")) * 1000;
      o.log?.(`usage api: HTTP ${res.status}`);
      return Math.max(backoff(), Number.isFinite(retry) ? retry : 0);
    }
    const rl = toRateLimits(await res.json());
    if (rl) o.limits.report({ rate_limits: rl }, "api");
    failures.n = 0;
    return interval;
  } catch (e) {
    o.log?.(`usage api: ${e instanceof Error ? e.message : String(e)}`);
    return backoff();
  }
}

/** Start polling; returns a stop function. */
export function startUsagePoll(o: PollOpts): () => void {
  const failures = { n: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const tick = async () => {
    const wait = await pollOnce(o, failures).catch(() => o.intervalMs ?? POLL_MS);
    if (!stopped) timer = setTimeout(tick, wait);
  };
  timer = setTimeout(tick, 5_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
