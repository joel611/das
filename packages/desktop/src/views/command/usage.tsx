import { duration, tokens } from "@/lib/format";
import type { LimitWindow, Session, Usage } from "@/lib/types";

import { sessionLabel } from "./agents";
import { Bar, Panel, PanelTitle, STATE_COLOR } from "./hud";
import { hud } from "@/lib/neon-theme";

const MODEL_COLOR = [
  hud["neon-cyan"],
  hud["neon-magenta"],
  hud["neon-amber"],
  hud["neon-green"],
  hud["hud-dim"],
];
const R = 50;
const CIRC = 2 * Math.PI * R;

/** A reading older than this is shown with its age. */
const STALE_MS = 30 * 60_000;

const limitColor = (pct: number) =>
  pct >= 95 ? "bg-neon-magenta" : pct >= 80 ? "bg-neon-amber" : "bg-neon-cyan";

/** One plan window: percent used and time to reset. */
function LimitRow({ label, w, now }: { label: string; w: LimitWindow | null; now: number }) {
  // An idle session's copy is only as fresh as its last response; say how old the reading is.
  const age = w ? now - w.observedAt : 0;
  const stale = age > STALE_MS;
  return (
    <div className="flex flex-col gap-1.25">
      <span className="flex justify-between font-mono text-xs">
        <span className="text-hud-text">{label}</span>
        <span className="font-bold text-hud-ink">{w ? `${Math.round(w.usedPercent)}%` : "—"}</span>
      </span>
      <Bar pct={w?.usedPercent ?? 0} h="h-1.5" className={limitColor(w?.usedPercent ?? 0)} />
      <span className="font-mono text-[10px] text-hud-faint">
        {!w
          ? "Not reported since the last reset"
          : w.resetsAt === null
            ? "No window running"
            : `Resets in ${duration(w.resetsAt - now)}`}
        {stale && ` · as of ${duration(age)} ago${w?.source === "api" ? " (usage API)" : ""}`}
      </span>
    </div>
  );
}

/** Burn rate sparkline; `series` is tokens per 5-minute bucket, oldest first. */
function Sparkline({ series }: { series: number[] }) {
  const max = Math.max(1, ...series);
  const step = 280 / Math.max(1, series.length - 1);
  const pts = series.map((v, i) => [i * step, 56 - (v / max) * 50] as const);
  const last = pts.at(-1);
  return (
    <svg
      viewBox="0 0 280 60"
      width="100%"
      height="60"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Tokens per 5 minutes over the last hour, peak ${tokens(max)}`}
    >
      <line x1="0" y1="59" x2="280" y2="59" stroke={hud["hud-line"]} />
      <line x1="0" y1="30" x2="280" y2="30" stroke={hud["hud-track"]} strokeDasharray="2 4" />
      <polyline
        points={pts.map((p) => p.join(",")).join(" ")}
        fill="none"
        stroke={hud["neon-amber"]}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      {last ? <circle cx={last[0]} cy={last[1]} r="3" fill={hud["neon-amber"]} /> : null}
    </svg>
  );
}

export function UsagePanel({
  usage,
  sessions,
  now,
}: {
  usage: Usage | undefined;
  sessions: Session[];
  now: number;
}) {
  const b = usage?.block ?? null;
  const limits = usage?.limits ?? null;
  const five = limits?.fiveHour ?? null;
  // The ring shows the real share of the 5-hour limit when Claude Code has reported it, else block time elapsed.
  const ringPct = five
    ? Math.round(five.usedPercent)
    : b
      ? Math.round(((now - b.start) / (b.end - b.start)) * 100)
      : 0;
  const ringLabel = five ? "USED" : "ELAPSED";
  const resetsIn = five?.resetsAt != null ? five.resetsAt - now : b ? b.end - now : 0;
  const top = b?.bySession[0]?.tokens ?? 1;
  const modelTotal = b?.byModel.reduce((n, m) => n + m.tokens, 0) || 1;
  const byId = new Map(sessions.map((s) => [s.id, s]));

  return (
    <>
      <Panel className="flex flex-col gap-4 px-4 pt-3.5 pb-4.5">
        <div className="flex items-baseline justify-between">
          <PanelTitle id="usage-h">USAGE</PanelTitle>
          <span className="font-mono text-[11px] text-hud-dim">5-HOUR BLOCK</span>
        </div>
        {b ? (
          <>
            <div className="flex items-center gap-4">
              <svg
                width="120"
                height="120"
                viewBox="0 0 120 120"
                className="shrink-0"
                role="img"
                aria-label={
                  five
                    ? `${ringPct} percent of the 5-hour limit used`
                    : `${ringPct} percent of the 5-hour block elapsed`
                }
              >
                <circle
                  cx="60"
                  cy="60"
                  r={R}
                  fill="none"
                  stroke={hud["hud-track"]}
                  strokeWidth="10"
                />
                <circle
                  cx="60"
                  cy="60"
                  r={R}
                  fill="none"
                  stroke={hud["neon-cyan"]}
                  strokeWidth="10"
                  strokeDasharray={`${(Math.min(100, ringPct) / 100) * CIRC} ${CIRC}`}
                  transform="rotate(-90 60 60)"
                />
                <circle
                  cx="60"
                  cy="60"
                  r="38"
                  fill="none"
                  stroke={hud["hud-ring"]}
                  strokeDasharray="2 4"
                />
                <text
                  x="60"
                  y="62"
                  textAnchor="middle"
                  fill={hud["hud-ink"]}
                  fontFamily="Chakra Petch, monospace"
                  fontSize="28"
                  fontWeight="700"
                >
                  {ringPct}%
                </text>
                <text
                  x="60"
                  y="80"
                  textAnchor="middle"
                  fill={hud["hud-dim"]}
                  fontFamily="JetBrains Mono Variable, monospace"
                  fontSize="9"
                  letterSpacing="1.5"
                >
                  {ringLabel}
                </text>
              </svg>
              <dl className="m-0 grid grid-cols-[auto_auto] gap-x-3 gap-y-1.5 font-mono text-xs">
                <dt className="text-hud-dim">RESETS</dt>
                <dd className="m-0 text-right text-hud-ink">{duration(resetsIn)}</dd>
                <dt className="text-hud-dim">TOKENS</dt>
                <dd className="m-0 text-right text-hud-ink">{tokens(b.tokens)}</dd>
                <dt className="text-hud-dim">CACHE RD</dt>
                <dd className="m-0 text-right text-hud-ink">{tokens(b.cacheRead)}</dd>
                <dt className="text-hud-dim">BURN</dt>
                <dd className="m-0 text-right text-neon-amber">{tokens(b.burnPerMin)}/min</dd>
              </dl>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="flex justify-between font-mono text-[11px] text-hud-dim">
                <span>BURN RATE · LAST 60 MIN</span>
                <span className="text-neon-amber">PEAK {tokens(Math.max(0, ...b.series))}</span>
              </span>
              <Sparkline series={b.series} />
            </div>
          </>
        ) : (
          <p className="m-0 font-mono text-xs text-hud-faint">
            No Claude activity in the last 5 hours that das has seen.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] tracking-[.08em] text-hud-dim">PLAN LIMITS</span>
          {limits ? (
            <>
              <LimitRow label="5-hour" w={limits.fiveHour} now={now} />
              <LimitRow label="Weekly" w={limits.sevenDay} now={now} />
            </>
          ) : (
            <span className="font-mono text-[11px] text-hud-faint">
              Not reported yet. Claude Code sends them to the das status line after its next
              response (Pro and Max plans only).
            </span>
          )}
        </div>
      </Panel>

      <Panel className="flex flex-1 flex-col gap-3 px-4 pt-3.5 pb-4.5">
        <div className="flex items-baseline justify-between">
          <PanelTitle tone="magenta">BY AGENT</PanelTitle>
          <span className="font-mono text-[11px] text-hud-dim">THIS BLOCK</span>
        </div>
        {(b?.bySession ?? []).slice(0, 8).map((a) => {
          const s = byId.get(a.session);
          return (
            <div key={a.session} className="flex flex-col gap-1">
              <span className="flex justify-between gap-2 font-mono text-xs">
                <span className="truncate text-hud-text">
                  {s
                    ? [sessionLabel(s), s.branch].filter(Boolean).join(" · ")
                    : `ended · ${a.session.slice(0, 8)}`}
                </span>
                <span className="text-hud-soft">{tokens(a.tokens)}</span>
              </span>
              <Bar pct={(a.tokens / top) * 100} className={STATE_COLOR[s?.state ?? "idle"].bg} />
            </div>
          );
        })}
        {!b?.bySession.length ? (
          <p className="m-0 font-mono text-xs text-hud-faint">No tokens counted in this block.</p>
        ) : null}
        {b?.byModel.length ? (
          <div className="mt-auto flex flex-wrap gap-3 border-t border-hud-rule pt-2.5 font-mono text-[11px] text-hud-dim">
            {b.byModel.map((m, i) => (
              <span key={m.model}>
                <span style={{ color: MODEL_COLOR[i % MODEL_COLOR.length] }} aria-hidden="true">
                  ■
                </span>{" "}
                <span className="capitalize">{m.model}</span>{" "}
                {Math.round((m.tokens / modelTotal) * 100)}%
              </span>
            ))}
          </div>
        ) : null}
      </Panel>
    </>
  );
}
