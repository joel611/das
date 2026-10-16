export type LimitWindow = {
  /** 0-100 */
  usedPercent: number;
  /** epoch ms; null when the source gives no reset time (idle account at 0%, or the Claude app's percentages) */
  resetsAt: number | null;
  /** epoch ms when a report last raised or replaced this window; repeats of the same value don't count */
  observedAt: number;
  /** which source made that report */
  source: LimitSource;
};

export type Limits = {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  /** epoch ms of the newest `observedAt` */
  updatedAt: number;
  /** source of that newest report: the Claude app file (app-usage.ts), or the opt-in usage API poll (usage-api.ts) */
  source: LimitSource;
};

export type LimitSource = "api" | "app";

const KEYS = { fiveHour: "five_hour", sevenDay: "seven_day" } as const;
const SPAN_MS = { fiveHour: 5 * 3_600_000, sevenDay: 7 * 86_400_000 } as const;
const TOLERANCE_MS = { fiveHour: 60_000, sevenDay: 300_000 } as const;

type Reported = { usedPercent: number; resetsAt: number | null };

function parseWindow(v: unknown): Reported | null {
  const w = v as { used_percentage?: unknown; resets_at?: unknown } | null;
  const pct = w?.used_percentage;
  const reset = w?.resets_at;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const usedPercent = Math.min(100, Math.max(0, pct));
  if (reset === null) return { usedPercent, resetsAt: null };
  if (typeof reset !== "number" || !Number.isFinite(reset)) return null;
  return { usedPercent, resetsAt: reset * 1000 };
}

export class LimitsTracker {
  private windows: { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null } = {
    fiveHour: null,
    sevenDay: null,
  };
  private updatedAt = 0;
  private source: LimitSource = "api";

  constructor(private now: () => number = Date.now) {}

  report(payload: unknown, source: LimitSource): boolean {
    const rl = (payload as { rate_limits?: Record<string, unknown> } | null)?.rate_limits;
    if (!rl || typeof rl !== "object") return false;
    let seen = false;
    let changed = false;
    const now = this.now();
    for (const key of ["fiveHour", "sevenDay"] as const) {
      const w = parseWindow(rl[KEYS[key]]);
      if (!w) continue;
      if (w.resetsAt === null && w.usedPercent > 0 && source !== "app") continue;
      if (
        w.resetsAt !== null &&
        (w.resetsAt <= now || w.resetsAt > now + SPAN_MS[key] + TOLERANCE_MS[key])
      )
        continue;
      const cur = this.windows[key];
      const tol = TOLERANCE_MS[key];
      const take = () => {
        this.windows[key] = { ...w, observedAt: now, source };
        changed = true;
      };
      if (w.resetsAt === null) {
        if (cur && cur.resetsAt !== null && cur.resetsAt > now) continue;
        if (!cur || cur.resetsAt !== null || cur.usedPercent !== w.usedPercent) take();
      } else if (!cur || cur.resetsAt === null || w.resetsAt > cur.resetsAt + tol) take();
      else if (w.resetsAt >= cur.resetsAt - tol) {
        if (w.usedPercent > cur.usedPercent) {
          cur.usedPercent = w.usedPercent;
          cur.observedAt = now;
          cur.source = source;
          changed = true;
        }
      } else continue;
      seen = true;
    }
    if (changed) {
      this.updatedAt = now;
      this.source = source;
    }
    return seen;
  }

  summary(now = this.now()): Limits | null {
    const live = (w: LimitWindow | null) =>
      w && (w.resetsAt === null || w.resetsAt > now) ? { ...w } : null;
    const fiveHour = live(this.windows.fiveHour);
    const sevenDay = live(this.windows.sevenDay);
    if (!fiveHour && !sevenDay) return null;
    return { fiveHour, sevenDay, updatedAt: this.updatedAt, source: this.source };
  }
}
