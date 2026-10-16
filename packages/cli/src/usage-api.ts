import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LimitsTracker } from "./limits";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const POLL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

type Creds = { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };

function tokenFrom(text: string, now: number): { token: string; expiresAt: number } | null {
  try {
    const o = (JSON.parse(text) as Creds).claudeAiOauth;
    if (typeof o?.accessToken !== "string" || !o.accessToken) return null;
    if (typeof o.expiresAt === "number" && o.expiresAt <= now) return null;
    return {
      token: o.accessToken,
      expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : Infinity,
    };
  } catch {
    return null;
  }
}

/**
 * Keychain service names to try. Claude Code scopes the item by config dir when it is not ~/.claude; the
 * unscoped item is only a fallback for the default dir, since otherwise it is another login's.
 */
export function keychainServices(claudeDir: string, home = homedir()): string[] {
  const base = "Claude Code-credentials";
  const dir = resolve(claudeDir);
  if (dir === join(home, ".claude")) return [base];
  return [`${base}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`];
}

/** `security` blocks on an unanswered Keychain prompt; give up so the poll loop keeps running. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

async function keychainText(service: string): Promise<string | null> {
  const p = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => p.kill(), KEYCHAIN_TIMEOUT_MS);
  try {
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : null;
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map<string, { token: string; expiresAt: number }>();

export async function readClaudeToken(
  claudeDir: string,
  now = Date.now(),
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;
  const key = resolve(claudeDir);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.token;
  cache.delete(key);
  const found = async () => {
    if (process.platform === "darwin") {
      for (const service of keychainServices(claudeDir)) {
        const out = await keychainText(service);
        const t = out && tokenFrom(out, now);
        if (t) return t;
      }
    }
    const file = await readFile(join(claudeDir, ".credentials.json"), "utf8").catch(() => null);
    return file ? tokenFrom(file, now) : null;
  };
  const t = await found();
  if (!t) return null;
  cache.set(key, t);
  return t.token;
}

const epochSec = (v: unknown) => {
  const ms = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v * 1000 : NaN;
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
};

/**
 * The API response as a `rate_limits` object ({five_hour, seven_day} of {used_percentage, resets_at}), the shape LimitsTracker.report reads.
 * Reads `five_hour` / `seven_day` ({utilization 0-100, resets_at ISO}), or a `limits` array of
 * {kind: "session" | "weekly_all", percent, resets_at} where an account gets that shape instead.
 */
export function toRateLimits(body: unknown): Record<string, unknown> | null {
  const b = body as Record<string, any> | null;
  if (!b || typeof b !== "object") return null;
  const win = (pct: unknown, reset: unknown) => {
    if (typeof pct !== "number") return undefined;
    const resets_at = epochSec(reset);
    if (resets_at) return { used_percentage: pct, resets_at };
    return pct === 0 && (reset === null || reset === undefined)
      ? { used_percentage: 0, resets_at: null }
      : undefined;
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

export async function pollOnce(
  o: PollOpts,
  failures: { n: number; noToken?: boolean },
): Promise<number> {
  const interval = o.intervalMs ?? POLL_MS;
  const now = o.now?.() ?? Date.now();
  if (!o.enabled()) return interval;
  const backoff = () => Math.min(MAX_BACKOFF_MS, interval * 2 ** ++failures.n);
  const token = await (o.readToken ?? (() => readClaudeToken(o.claudeDir)))();
  if (!token) {
    if (!failures.noToken)
      o.log?.("usage api: no Claude Code login token found (or it has expired)");
    failures.noToken = true;
    return interval;
  }
  failures.noToken = false;
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

export function startUsagePoll(o: PollOpts): () => void {
  const failures: { n: number; noToken?: boolean } = { n: 0 };
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
