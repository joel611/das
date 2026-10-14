import { useState } from "react";

import { useNow } from "@/hooks/use-now";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { clock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Command } from "@/views/command";
import { Console } from "@/views/console";
import { Debug } from "@/views/debug";
import { Overview } from "@/views/overview";
import { Settings } from "@/views/settings";
import { hud } from "@/lib/neon-theme";

const TABS = [
  { id: "command", label: "Command" },
  { id: "overview", label: "Overview" },
  { id: "console", label: "Console" },
  { id: "debug", label: "Debug" },
  { id: "settings", label: "Settings" },
] as const;

type Tab = (typeof TABS)[number]["id"];

function StatusChip({
  tone,
  children,
}: {
  tone: "ok" | "bad" | "info";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 border px-2.5 py-1.5",
        tone === "ok" && "border-hud-ok-line text-neon-green",
        tone === "bad" && "border-hud-bad-line text-neon-pink",
        tone === "info" && "border-hud-chip text-hud-soft",
      )}
    >
      <span
        className={cn(
          "size-[7px]",
          tone === "ok" && "bg-neon-green shadow-[0_0_8px_var(--theme-neon-green)]",
          tone === "bad" && "bg-neon-magenta",
          tone === "info" && "bg-neon-cyan",
        )}
      />
      {children}
    </span>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("command");
  const state = usePoll(api.state, 2000);
  const now = useNow(1000);
  const s = state.data;

  return (
    <div data-ui-scroll-container className="hud-grid flex flex-col font-hud text-hud-text">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-hud-line bg-hud-shade/92 px-6 py-3.5">
        <div className="flex items-center gap-3">
          <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
            <polygon
              points="15,2 28,9.5 28,20.5 15,28 2,20.5 2,9.5"
              fill="none"
              stroke={hud["neon-cyan"]}
              strokeWidth="1.5"
            />
            <circle cx="15" cy="15" r="4.5" fill={hud["neon-cyan"]} />
          </svg>
          <div className="flex flex-col leading-none">
            <h1 className="m-0 text-xl font-bold tracking-[.28em] text-hud-ink">DAS</h1>
            <span className="mt-1 font-mono text-[10px] tracking-[.22em] text-hud-dim">
              COMMAND CENTER
            </span>
          </div>
        </div>
        <nav aria-label="Views" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
              className={cn(
                "min-h-9 cursor-pointer border px-3.5 py-2 font-hud text-xs font-semibold tracking-[.18em] uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon-amber",
                tab === t.id
                  ? "border-neon-cyan bg-neon-cyan/12 text-neon-cyan"
                  : "border-transparent bg-transparent text-hud-dim hover:text-hud-ink",
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div
          className="ml-auto flex flex-wrap gap-2.5 font-mono text-[11px] tracking-[.08em] uppercase"
          role="status"
        >
          {s ? (
            <StatusChip tone="ok">daemon online · {s.display.headline}</StatusChip>
          ) : (
            <StatusChip tone="bad">daemon not running</StatusChip>
          )}
          {s ? (
            <StatusChip tone="info">
              {s.devices
                ? `stack-chan linked${s.devices > 1 ? ` ×${s.devices}` : ""}`
                : "no device"}
            </StatusChip>
          ) : null}
          {s ? (
            <span className="border border-hud-chip px-2.5 py-1.5 text-hud-soft">
              {s.projects} projects
            </span>
          ) : null}
          <span className="px-2.5 py-1.5 font-bold text-hud-ink tabular-nums">{clock(now)}</span>
        </div>
      </header>
      {/* All views stay mounted so conversations survive a tab switch. */}
      <main className="flex-1 p-4">
        <div hidden={tab !== "command"}>
          <Command />
        </div>
        <div hidden={tab !== "overview"} className="mx-auto max-w-5xl font-sans">
          <Overview />
        </div>
        <div hidden={tab !== "console"} className="mx-auto max-w-5xl font-sans">
          <Console />
        </div>
        <div hidden={tab !== "debug"} className="mx-auto max-w-5xl font-sans">
          {/* Only poll while visible; the other views stay mounted but this one is chatty. */}
          {tab === "debug" ? <Debug /> : null}
        </div>
        <div hidden={tab !== "settings"} className="mx-auto max-w-5xl font-sans">
          <Settings />
        </div>
      </main>
    </div>
  );
}
