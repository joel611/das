import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LimitsTracker } from "./limits";

export const FRESH_MS = 30 * 60_000;
export const POLL_MS = 60_000;
const MAX_BYTES = 4 << 20;
const STATUSLINE_QUIET_MS = 5 * 60_000;

export const historyFile = (home = homedir()) =>
  join(home, "Library", "Application Support", "Claude", "plan-usage-history.json");

export type AppReading = { at: number; fiveHour?: number; sevenDay?: number };

const pct = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : undefined;

/**
 * The newest reading (version 1 keeps `fh`/`sd` beside `t`, version 2 under `u`). The app may be signed in
 * to another account than Claude Code: readings of another organization are skipped.
 */
export function parseHistory(text: string, organization?: string): AppReading | null {
  if (text.length > MAX_BYTES) return null;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if ((json?.version !== 1 && json?.version !== 2) || !Array.isArray(json.samples)) return null;
  let best: AppReading | null = null;
  for (const e of json.samples) {
    const at = e?.t;
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
    if (organization && typeof e.org === "string" && e.org !== organization) continue;
    if (best && at <= best.at) continue;
    const u = json.version === 1 ? e : e.u;
    best = { at, fiveHour: pct(u?.fh), sevenDay: pct(u?.sd) };
  }
  return best && (best.fiveHour !== undefined || best.sevenDay !== undefined) ? best : null;
}

export async function accountOrganization(
  claudeDir: string,
  home = homedir(),
): Promise<string | undefined> {
  const file =
    claudeDir === join(home, ".claude")
      ? join(home, ".claude.json")
      : join(claudeDir, ".claude.json");
  try {
    const org = JSON.parse(await readFile(file, "utf8"))?.oauthAccount?.organizationUuid;
    return typeof org === "string" && org ? org : undefined;
  } catch {
    return undefined;
  }
}

export function toRateLimits(reading: AppReading, limits: LimitsTracker, now: number) {
  if (now - reading.at >= FRESH_MS || reading.at > now + 5 * 60_000) return null;
  const known = limits.summary(now);
  const out: Record<string, unknown> = {};
  for (const [key, used, w] of [
    ["five_hour", reading.fiveHour, known?.fiveHour],
    ["seven_day", reading.sevenDay, known?.sevenDay],
  ] as const) {
    if (used === undefined) continue;
    if (w && w.observedAt >= reading.at) continue;
    out[key] = {
      used_percentage: used,
      resets_at: w?.resetsAt != null ? Math.round(w.resetsAt / 1000) : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

type PollOpts = {
  limits: LimitsTracker;
  claudeDir: string;
  home?: string;
  now?: () => number;
  log?: (msg: string) => void;
};

export async function pollOnce(o: PollOpts): Promise<boolean> {
  const now = o.now?.() ?? Date.now();
  if (now - o.limits.statusLineAt < STATUSLINE_QUIET_MS) return false;
  const home = o.home ?? homedir();
  const text = await readFile(historyFile(home), "utf8").catch(() => null);
  if (!text) return false;
  const reading = parseHistory(text, await accountOrganization(o.claudeDir, home));
  const rl = reading && toRateLimits(reading, o.limits, now);
  return rl ? o.limits.report({ rate_limits: rl }, "app") : false;
}

export function startAppPoll(o: PollOpts): () => void {
  const timer = setInterval(
    () => void pollOnce(o).catch((e) => o.log?.(`app usage: ${e}`)),
    POLL_MS,
  );
  timer.unref();
  return () => clearInterval(timer);
}
