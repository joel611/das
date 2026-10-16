/**
 * Plan limits (percent of the 5-hour and weekly allowance used), as Claude Code reports them to its
 * status line command in `rate_limits`. These are the numbers `/usage` shows; transcripts and hooks
 * do not carry them. statusline.sh forwards each status line payload here.
 *
 * Every session reports the same account-wide windows, but an idle session's copy is only as fresh as
 * its last API response. So within one window (same reset time) the percent only goes up, and a later
 * reset time replaces the window.
 */

export type LimitWindow = {
  /** 0-100 */
  usedPercent: number;
  /** epoch ms; null when the usage API reports an idle account (0% used, no window running) */
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
  /** source of that newest report: the status line, or the opt-in usage API poll (usage-api.ts) */
  source: LimitSource;
};

export type LimitSource = "statusline" | "api";

const KEYS = { fiveHour: "five_hour", sevenDay: "seven_day" } as const;
const SPAN_MS = { fiveHour: 5 * 3_600_000, sevenDay: 7 * 86_400_000 } as const;
/** Reports of one window can differ by rounding or jitter between sessions and sources. */
const TOLERANCE_MS = { fiveHour: 60_000, sevenDay: 300_000 } as const;

type Reported = { usedPercent: number; resetsAt: number | null };

function parseWindow(v: unknown): Reported | null {
  const w = v as { used_percentage?: unknown; resets_at?: unknown } | null;
  const pct = w?.used_percentage;
  const reset = w?.resets_at;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const usedPercent = Math.min(100, Math.max(0, pct));
  // An idle account has no window to reset; only 0% can say so.
  if (reset === null && usedPercent === 0) return { usedPercent, resetsAt: null };
  if (typeof reset !== "number" || !Number.isFinite(reset)) return null;
  return { usedPercent, resetsAt: reset * 1000 };
}

const short = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d${h}h` : h ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

export class LimitsTracker {
  private windows: { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null } = {
    fiveHour: null,
    sevenDay: null,
  };
  private updatedAt = 0;
  private source: LimitSource = "statusline";
  /** epoch ms of the last status line report that raised or replaced a window */
  statusLineAt = 0;

  constructor(private now: () => number = Date.now) {}

  /** Take a status line payload; returns whether it carried any usable limit. */
  report(payload: unknown, source: LimitSource = "statusline"): boolean {
    const rl = (payload as { rate_limits?: Record<string, unknown> } | null)?.rate_limits;
    if (!rl || typeof rl !== "object") return false;
    let seen = false;
    let changed = false;
    const now = this.now();
    for (const key of ["fiveHour", "sevenDay"] as const) {
      const w = parseWindow(rl[KEYS[key]]);
      // A reset can't be in the past or further out than the window is long: a forged far-future one
      // would otherwise pin the window, since a later reset time always replaces an earlier one.
      if (!w) continue;
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
        // Idle account: never replaces a window that is still running.
        if (cur && cur.resetsAt !== null && cur.resetsAt > now) continue;
        if (!cur || cur.resetsAt !== null || cur.usedPercent !== 0) take();
      } else if (!cur || cur.resetsAt === null || w.resetsAt > cur.resetsAt + tol) take();
      else if (w.resetsAt >= cur.resetsAt - tol) {
        if (w.usedPercent > cur.usedPercent) {
          cur.usedPercent = w.usedPercent;
          cur.observedAt = now;
          cur.source = source;
          changed = true;
        }
      } else continue; // an older window than the one we hold
      seen = true;
    }
    if (changed) {
      this.updatedAt = now;
      this.source = source;
      // Only a change counts as the status line being alive: an idle session repeats its last values.
      if (source === "statusline") this.statusLineAt = now;
    }
    return seen;
  }

  /** Current limits; a window whose reset time has passed is unknown again (null). */
  summary(now = this.now()): Limits | null {
    const live = (w: LimitWindow | null) =>
      w && (w.resetsAt === null || w.resetsAt > now) ? { ...w } : null;
    const fiveHour = live(this.windows.fiveHour);
    const sevenDay = live(this.windows.sevenDay);
    if (!fiveHour && !sevenDay) return null;
    return { fiveHour, sevenDay, updatedAt: this.updatedAt, source: this.source };
  }

  /** One short line for the status line when the user had none of their own: "5h 23% (2h14m) · 7d 41% (3d4h)". */
  line(now = this.now()): string {
    const l = this.summary(now);
    if (!l) return "";
    const part = (label: string, w: LimitWindow | null) =>
      w
        ? `${label} ${Math.round(w.usedPercent)}%${w.resetsAt === null ? "" : ` (${short(w.resetsAt - now)})`}`
        : null;
    return [part("5h", l.fiveHour), part("7d", l.sevenDay)].filter(Boolean).join(" · ");
  }
}
