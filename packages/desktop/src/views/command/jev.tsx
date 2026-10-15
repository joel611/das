import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { useVoice } from "@/lib/queries";
import { hhmm } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Project, Session, VoiceReply } from "@/lib/types";
import { hud } from "@/lib/neon-theme";
import { useJevStyle } from "@/lib/jev-style";

import { AsciiOrb, AsciiScope } from "./jev-ascii";

type Msg = { id: number; at: number } & ({ you: string } | { reply: VoiceReply; dry: boolean });

const HEIGHTS = [
  6, 10, 16, 22, 14, 28, 18, 30, 12, 24, 32, 20, 10, 26, 34, 22, 14, 30, 18, 26, 12, 20, 28, 16, 10,
  22, 14, 18, 8, 12, 6, 10,
];

const STATUS_TONE: Record<VoiceReply["status"], string> = {
  spawned: "text-neon-green",
  "dry-run": "text-neon-cyan",
  ask: "text-neon-amber",
  escalate: "text-neon-amber",
  error: "text-neon-pink",
};

function Orb({ hot }: { hot: boolean }) {
  return (
    <svg
      viewBox="0 0 300 300"
      className="block h-auto w-full"
      role="img"
      aria-label="Jev status orb"
    >
      <g className="hud-spin-slow">
        <circle cx="150" cy="150" r="146" fill="none" stroke={hud["hud-ring"]} strokeWidth="1" />
        <circle
          cx="150"
          cy="150"
          r="146"
          fill="none"
          stroke={hud["neon-cyan"]}
          strokeWidth="2"
          strokeDasharray="2 10"
          opacity=".55"
        />
      </g>
      <g className="hud-spin">
        <circle
          cx="150"
          cy="150"
          r="124"
          fill="none"
          stroke={hud["neon-cyan"]}
          strokeWidth="3"
          strokeDasharray="120 40 30 40 200 30"
          opacity=".85"
        />
      </g>
      <g className="hud-spin-rev">
        <circle
          cx="150"
          cy="150"
          r="104"
          fill="none"
          stroke={hud["neon-magenta"]}
          strokeWidth="2"
          strokeDasharray="60 24 8 24"
          opacity=".8"
        />
      </g>
      <g className="hud-spin">
        <circle
          cx="150"
          cy="150"
          r="86"
          fill="none"
          stroke={hud["neon-cyan"]}
          strokeWidth="1"
          strokeDasharray="1 5"
          opacity=".9"
        />
      </g>
      <circle
        cx="150"
        cy="150"
        r="70"
        fill={hud["neon-cyan"]}
        fillOpacity=".05"
        stroke={hud["neon-cyan"]}
        strokeWidth="1"
        opacity=".6"
      />
      <g className={hot ? "hud-pulse-hot" : "hud-pulse"}>
        <circle
          cx="150"
          cy="150"
          r="46"
          fill={hud["neon-cyan"]}
          fillOpacity=".14"
          stroke={hud["neon-cyan"]}
          strokeWidth="2"
        />
        <circle cx="150" cy="150" r="26" fill={hud["neon-cyan"]} opacity=".9" />
        <circle cx="150" cy="150" r="12" fill={hud["hud-ink"]} />
      </g>
      <line x1="4" y1="150" x2="36" y2="150" stroke={hud["neon-cyan"]} />
      <line x1="264" y1="150" x2="296" y2="150" stroke={hud["neon-cyan"]} />
      <line x1="150" y1="4" x2="150" y2="22" stroke={hud["neon-magenta"]} />
      <line x1="150" y1="278" x2="150" y2="296" stroke={hud["neon-magenta"]} />
    </svg>
  );
}

function Bars({ busy }: { busy: boolean }) {
  return (
    <div className="flex h-[34px] items-center gap-[3px]" aria-hidden="true">
      {HEIGHTS.map((h, i) => (
        <span
          key={i}
          className={cn("block w-[3px] origin-center", busy && "hud-wave")}
          style={{
            height: busy ? 34 : h,
            background: i % 7 === 3 ? hud["neon-magenta"] : hud["neon-cyan"],
            opacity: busy ? 1 : 0.45,
            animationDelay: `${(i * 53) % 900}ms`,
          }}
        />
      ))}
    </div>
  );
}

function RouteCard({ r }: { r: VoiceReply }) {
  const d = r.debug;
  const project = r.project ?? d?.choice;
  if (!project && !d) return null;
  const worktree = d?.name
    ? `new: ${d.name}`
    : d?.worktree
      ? d.worktree.split("/").pop()
      : "project main";
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 border border-hud-chip bg-neon-cyan/5 px-3 py-2.5 font-mono text-[11px]">
      <span className="truncate text-hud-dim">
        PROJECT <span className="text-hud-ink">{project ?? "none"}</span>
      </span>
      <span className="text-hud-dim">
        CONFIDENCE <span className="text-neon-green">{d ? d.confidence.toFixed(2) : "-"}</span>
      </span>
      <span className="truncate text-hud-dim">
        WORKTREE <span className="text-hud-ink">{d ? worktree : "-"}</span>
      </span>
      <span className="text-hud-dim">
        STATUS <span className={cn("uppercase", STATUS_TONE[r.status])}>{r.status}</span>
      </span>
    </div>
  );
}

const AUTO = "auto";

const newDevice = () => "jev-" + Math.random().toString(36).slice(2, 8);

export function JevPanel({ sessions, projects }: { sessions: Session[]; projects: Project[] }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const voice = useVoice();
  const busy = voice.isPending;
  const [dry, setDry] = useState(true);
  const [pendingReal, setPendingReal] = useState<string | null>(null);
  const [device, setDevice] = useState(newDevice);
  const [style] = useJevStyle();
  const log = useRef<HTMLDivElement>(null);
  const [project, setProject] = useState(""); // "" = auto

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [msgs, busy, pendingReal]);

  async function run(text: string, isDry: boolean) {
    setMsgs((m) => [...m, { id: Date.now(), at: Date.now(), you: text }]);
    let reply: VoiceReply;
    try {
      const hinted = project ? `Start a session in ${project} to ${text}` : text;
      reply = await voice.mutateAsync({ text: hinted, device, dryRun: isDry });
    } catch (e) {
      reply = { status: "error", text: e instanceof Error ? e.message : String(e) };
    }
    setMsgs((m) => [...m, { id: Date.now() + 1, at: Date.now(), reply, dry: isDry }]);
  }

  function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    if (!dry) {
      // A real send starts a Claude session, so it needs a second, explicit click.
      setPendingReal(text);
      return;
    }
    setDraft("");
    void run(text, true);
  }

  function confirmReal() {
    const text = pendingReal;
    setPendingReal(null);
    if (!text || dry) return;
    setDraft("");
    void run(text, false);
  }

  const projectItems = [AUTO, ...projects.map((p) => p.name)];
  const running = sessions.filter((s) => s.state === "running").length;
  const needsYou = sessions.filter((s) => s.state === "waiting" || s.state === "error").length;

  return (
    <section
      aria-label="Jev assistant"
      className="hud flex min-w-0 flex-col border border-hud-line bg-hud-shade/75"
    >
      <div className="flex items-center justify-between border-b border-hud-rule px-5 py-3.5 font-mono text-[11px] tracking-[.12em] text-hud-dim">
        <span>JEV // VOICE ROUTER</span>
        <span
          className={cn("flex items-center gap-2", busy ? "text-neon-amber" : "text-neon-green")}
        >
          <span className={cn("hud-blink size-1.5", busy ? "bg-neon-amber" : "bg-neon-green")} />
          {busy ? "ROUTING" : "STANDBY"}
        </span>
      </div>

      <div className="flex flex-col items-center gap-3.5 px-5 pt-6 pb-2">
        {style === "ascii" ? (
          <>
            <AsciiOrb hot={busy} />
            <AsciiScope hot={busy} />
          </>
        ) : (
          <>
            <div className="w-full max-w-[300px]">
              <Orb hot={busy} />
            </div>
            <Bars busy={busy} />
          </>
        )}
        <p className="m-0 text-center font-hud text-sm tracking-[.06em] text-hud-soft">
          {busy
            ? "Matching your request to a project…"
            : `${sessions.length} agents tracked · ${running} running · ${needsYou} need${needsYou === 1 ? "s" : ""} you`}
        </p>
      </div>

      <div
        ref={log}
        role="log"
        aria-live="polite"
        className="flex min-h-[220px] flex-1 flex-col gap-3.5 overflow-y-auto px-6 pt-2 pb-4"
      >
        {msgs.length === 0 ? (
          <p className="m-0 font-mono text-xs text-hud-faint">
            Tell Jev what to start, as you would say it to the robot. Dry run is on: Jev decides,
            nothing starts.
          </p>
        ) : null}
        {msgs.map((m) =>
          "you" in m ? (
            <div key={m.id} className="flex max-w-[560px] flex-col items-end gap-1.5 self-end">
              <span className="font-mono text-[10px] tracking-[.14em] text-hud-faint">
                YOU · {hhmm(m.at)}
              </span>
              <span className="border border-hud-bad-line bg-neon-magenta/8 px-3.5 py-2.5 font-hud text-[15px] leading-normal whitespace-pre-wrap text-hud-hot-ink select-text">
                {m.you}
              </span>
            </div>
          ) : (
            <div key={m.id} className="flex max-w-[760px] gap-3">
              <span className="flex size-[30px] shrink-0 items-center justify-center border border-neon-cyan font-hud text-[11px] font-bold text-neon-cyan">
                J
              </span>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="font-mono text-[10px] tracking-[.14em] text-hud-faint">
                  JEV · {hhmm(m.at)}
                  {m.dry ? " · DRY RUN" : ""}
                </span>
                <span
                  className={cn(
                    "font-hud text-[15px] leading-normal select-text",
                    m.reply.status === "error" ? "text-neon-pink" : "text-hud-text",
                  )}
                >
                  {m.reply.text}
                </span>
                <RouteCard r={m.reply} />
              </div>
            </div>
          ),
        )}
        {busy ? (
          <span className="font-mono text-xs text-neon-cyan">
            JEV is routing<span className="hud-blink">_</span>
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2.5 border-t border-hud-rule px-5 pt-3 pb-5">
        {pendingReal ? (
          <div
            role="alertdialog"
            aria-label="Confirm real request"
            className="flex flex-col gap-2 border border-neon-magenta bg-neon-magenta/10 px-3 py-2.5 font-mono text-xs text-hud-hot-ink"
          >
            <span>
              Send for real? This starts a Claude session in auto mode in an isolated worktree:{" "}
              <q className="text-hud-ink">{pendingReal}</q>
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={confirmReal}
                className="min-h-9 cursor-pointer border-0 bg-neon-magenta px-3 font-hud font-semibold tracking-[.12em] text-hud-void"
              >
                YES, SEND FOR REAL
              </button>
              <button
                type="button"
                onClick={() => setPendingReal(null)}
                className="min-h-9 cursor-pointer border border-hud-edge bg-transparent px-3 font-hud tracking-[.12em] text-hud-soft"
              >
                CANCEL
              </button>
            </span>
          </div>
        ) : null}
        <form
          onSubmit={send}
          className="flex items-center gap-2 border border-hud-edge bg-hud-surface py-1.5 pr-1.5 pl-4 focus-within:border-neon-cyan focus-within:shadow-[0_0_0_1px_var(--theme-neon-cyan),0_0_24px_color-mix(in_srgb,var(--theme-neon-cyan)_25%,transparent)]"
        >
          <span aria-hidden="true" className="font-mono font-bold text-neon-magenta">
            &gt;
          </span>
          <label htmlFor="jev-cmd" className="sr-only">
            Command for Jev
          </label>
          <input
            id="jev-cmd"
            type="text"
            autoComplete="off"
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setPendingReal(null);
            }}
            placeholder="Ask Jev, or say what to start…"
            className="h-11 min-w-0 flex-1 border-0 bg-transparent font-mono text-[15px] text-hud-ink outline-none placeholder:text-hud-faint"
          />
          <button
            type="submit"
            aria-label="Send to Jev"
            disabled={busy || !draft.trim()}
            className="flex size-11 cursor-pointer items-center justify-center border-0 bg-neon-cyan text-hud-void disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="4" y1="12" x2="19" y2="12" />
              <polyline points="13 6 19 12 13 18" />
            </svg>
          </button>
        </form>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tracking-[.1em] text-hud-faint">
          <span>ENTER to send</span>
          <div className="flex items-center gap-1.5">
            PROJECT
            <Combobox
              items={projectItems}
              value={project || AUTO}
              onValueChange={(v) => {
                setProject(!v || v === AUTO ? "" : v);
                setPendingReal(null);
              }}
            >
              <ComboboxInput className="w-44 font-mono text-[11px]" placeholder="auto" />
              <ComboboxContent>
                <ComboboxEmpty>No project</ComboboxEmpty>
                <ComboboxList>
                  {(item: string) => (
                    <ComboboxItem key={item} value={item}>
                      {item}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={dry}
              onChange={(e) => {
                setDry(e.target.checked);
                setPendingReal(null);
              }}
              className="accent-neon-cyan"
            />
            DRY RUN{" "}
            <span className={dry ? "text-neon-cyan" : "text-neon-pink"}>{dry ? "ON" : "OFF"}</span>
          </label>
          <button
            type="button"
            onClick={() => {
              setDevice(newDevice());
              setMsgs([]);
              setPendingReal(null);
            }}
            className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10px] tracking-[.1em] text-hud-dim underline-offset-2 hover:text-neon-cyan hover:underline"
          >
            NEW CONVERSATION
          </button>
          <span>routes to the best-matching project, spawns in an isolated worktree</span>
        </div>
      </div>
    </section>
  );
}
