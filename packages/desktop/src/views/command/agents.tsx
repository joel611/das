import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Session, SessionState } from "@/lib/types";

import { Panel, PanelTitle, STATE_COLOR, URGENCY } from "./hud";

export const sessionLabel = (s: Session) => s.project ?? s.cwd.split("/").pop() ?? s.cwd;

export function AgentsPanel({
  sessions,
  selected,
  onSelect,
  now,
}: {
  sessions: Session[];
  selected: Session | undefined;
  onSelect: (id: string) => void;
  now: number;
}) {
  const active = sessions.filter((s) => s.state === "running" || s.state === "waiting").length;
  const counts = URGENCY.filter((st) => st !== "idle" && st !== "done")
    .map((st) => [st, sessions.filter((s) => s.state === st).length] as const)
    .filter(([, n]) => n > 0);

  return (
    <Panel className="flex flex-col">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5">
        <PanelTitle id="agents-h">RUNNING AGENTS</PanelTitle>
        <span className="font-mono text-[11px] text-hud-dim">
          {active} / {sessions.length}
        </span>
      </div>
      {counts.length ? (
        <div className="flex flex-wrap gap-1.5 px-4 pb-3 font-mono text-[10px] tracking-[.08em]">
          {counts.map(([st, n]) => (
            <span
              key={st}
              className={cn("px-1.5 py-0.5 uppercase", STATE_COLOR[st].text, CHIP_BG[st])}
            >
              {n} {st}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex max-h-[26rem] flex-col overflow-y-auto border-t border-hud-rule">
        {sessions.length === 0 ? (
          <p className="m-0 px-4 py-4 font-mono text-xs text-hud-faint">
            No agents yet. Install the hooks in Settings, then start a Claude session.
          </p>
        ) : null}
        {sessions.map((s) => {
          const on = s.id === selected?.id;
          const c = STATE_COLOR[s.state];
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(s.id)}
              className={cn(
                "flex min-h-14 w-full cursor-pointer flex-col gap-1.5 border-0 border-b border-l-[3px] border-b-hud-rule px-4 py-2.5 text-left font-hud text-inherit hover:bg-hud-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-neon-amber",
                on ? cn(c.border, "bg-neon-cyan/7") : "border-l-transparent bg-transparent",
              )}
            >
              <span className="flex w-full items-center gap-2.5">
                <span
                  className={cn("size-2 shrink-0", c.bg)}
                  style={s.state === "running" ? { boxShadow: `0 0 10px ${c.glow}` } : undefined}
                />
                <span className="text-sm font-semibold text-hud-ink">{sessionLabel(s)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-hud-dim">
                  {s.branch ?? ""}
                </span>
                <span
                  className={cn(
                    "shrink-0 border px-1 py-px font-mono text-[9px] tracking-[.1em] uppercase",
                    c.border,
                    c.text,
                  )}
                >
                  {s.state}
                </span>
              </span>
              <span className="flex w-full justify-between gap-2 pl-[18px] font-mono text-[11px]">
                <span className="min-w-0 truncate text-hud-soft">
                  {s.detail ?? STATE_HINT[s.state]}
                </span>
                <span className="shrink-0 text-hud-faint">{ago(s.updatedAt, now)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

const CHIP_BG: Record<SessionState, string> = {
  running: "bg-neon-cyan/12",
  waiting: "bg-neon-amber/14",
  error: "bg-neon-magenta/14",
  done: "bg-neon-green/12",
  idle: "bg-hud-track",
};

const STATE_HINT: Record<SessionState, string> = {
  running: "Working",
  waiting: "Needs you",
  error: "Errored",
  done: "Finished its turn",
  idle: "Idle",
};
