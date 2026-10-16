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
  /** epoch ms */
  resetsAt: number;
};

export type Limits = {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  /** epoch ms of the last report that changed or confirmed a window */
  updatedAt: number;
  /** where the last report came from: the status line, or the opt-in usage API poll (usage-api.ts) */
  source: LimitSource;
};

export type LimitSource = "statusline" | "api";

const KEYS = { fiveHour: "five_hour", sevenDay: "seven_day" } as const;
const SPAN_MS = { fiveHour: 5 * 3_600_000, sevenDay: 7 * 86_400_000 } as const;
/** Reports of one window can differ by rounding or jitter between sessions and sources. */
const TOLERANCE_MS = { fiveHour: 60_000, sevenDay: 300_000 } as const;

function parseWindow(v: unknown): LimitWindow | null {
  const w = v as { used_percentage?: unknown; resets_at?: unknown } | null;
  const pct = w?.used_percentage;
  const reset = w?.resets_at;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  if (typeof reset !== "number" || !Number.isFinite(reset)) return null;
  return { usedPercent: Math.min(100, Math.max(0, pct)), resetsAt: reset * 1000 };
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
  /** epoch ms of the last status line report that carried limits */
  statusLineAt = 0;

  constructor(private now: () => number = Date.now) {}

  /** Take a status line payload; returns whether it carried any limit. */
  report(payload: unknown, source: LimitSource = "statusline"): boolean {
    const rl = (payload as { rate_limits?: Record<string, unknown> } | null)?.rate_limits;
    if (!rl || typeof rl !== "object") return false;
    let seen = false;
    const now = this.now();
    for (const key of ["fiveHour", "sevenDay"] as const) {
      const w = parseWindow(rl[KEYS[key]]);
      // A reset can't be in the past or further out than the window is long: a forged far-future one
      // would otherwise pin the window, since a later reset time always replaces an earlier one.
      if (!w || w.resetsAt <= now || w.resetsAt > now + SPAN_MS[key] + TOLERANCE_MS[key]) continue;
      const cur = this.windows[key];
      const tol = TOLERANCE_MS[key];
      if (!cur || w.resetsAt > cur.resetsAt + tol) this.windows[key] = w;
      else if (w.resetsAt >= cur.resetsAt - tol) {
        if (w.usedPercent > cur.usedPercent) cur.usedPercent = w.usedPercent;
      } else continue; // an older window than the one we hold
      seen = true;
    }
    if (seen) {
      this.updatedAt = this.now();
      this.source = source;
      if (source === "statusline") this.statusLineAt = this.updatedAt;
    }
    return seen;
  }

  /** Current limits; a window whose reset time has passed is unknown again (null). */
  summary(now = this.now()): Limits | null {
    const live = (w: LimitWindow | null) => (w && w.resetsAt > now ? { ...w } : null);
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
      w ? `${label} ${Math.round(w.usedPercent)}% (${short(w.resetsAt - now)})` : null;
    return [part("5h", l.fiveHour), part("7d", l.sevenDay)].filter(Boolean).join(" · ");
  }
}
