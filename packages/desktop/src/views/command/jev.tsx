import { type FormEvent, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { hhmm } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Project, Session, VoiceReply } from "@/lib/types";

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
        <circle cx="150" cy="150" r="146" fill="none" stroke="#16314a" strokeWidth="1" />
        <circle
          cx="150"
          cy="150"
          r="146"
          fill="none"
          stroke="#2ee9ff"
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
          stroke="#2ee9ff"
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
          stroke="#ff3d8b"
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
          stroke="#2ee9ff"
          strokeWidth="1"
          strokeDasharray="1 5"
          opacity=".9"
        />
      </g>
      <circle
        cx="150"
        cy="150"
        r="70"
        fill="rgba(46,233,255,.05)"
        stroke="#2ee9ff"
        strokeWidth="1"
        opacity=".6"
      />
      <g className={hot ? "hud-pulse-hot" : "hud-pulse"}>
        <circle
          cx="150"
          cy="150"
          r="46"
          fill="rgba(46,233,255,.14)"
          stroke="#2ee9ff"
          strokeWidth="2"
        />
        <circle cx="150" cy="150" r="26" fill="#2ee9ff" opacity=".9" />
        <circle cx="150" cy="150" r="12" fill="#e8fbff" />
      </g>
      <line x1="4" y1="150" x2="36" y2="150" stroke="#2ee9ff" />
      <line x1="264" y1="150" x2="296" y2="150" stroke="#2ee9ff" />
      <line x1="150" y1="4" x2="150" y2="22" stroke="#ff3d8b" />
      <line x1="150" y1="278" x2="150" y2="296" stroke="#ff3d8b" />
    </svg>
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
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 border border-[#1d3347] bg-neon-cyan/5 px-3 py-2.5 font-mono text-[11px]">
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

const newDevice = () => "jev-" + Math.random().toString(36).slice(2, 8);

export function JevPanel({ sessions, projects }: { sessions: Session[]; projects: Project[] }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [dry, setDry] = useState(true);
  const [pendingReal, setPendingReal] = useState<string | null>(null);
  const [device, setDevice] = useState(newDevice);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [msgs, busy, pendingReal]);

  async function run(text: string, isDry: boolean) {
    setMsgs((m) => [...m, { id: Date.now(), at: Date.now(), you: text }]);
    setBusy(true);
    let reply: VoiceReply;
    try {
      reply = await api.voice(text, device, isDry);
    } catch (e) {
      reply = { status: "error", text: e instanceof Error ? e.message : String(e) };
    }
    setMsgs((m) => [...m, { id: Date.now() + 1, at: Date.now(), reply, dry: isDry }]);
    setBusy(false);
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

  const running = sessions.filter((s) => s.state === "running").length;
  const needsYou = sessions.filter((s) => s.state === "waiting" || s.state === "error").length;
  const chips = projects.slice(0, 3).map((p) => `Start a session in ${p.name} to `);

  return (
    <section
      aria-label="Jev assistant"
      className="hud flex min-w-0 flex-col border border-hud-line bg-[rgb(6_10_18/.75)]"
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
        <div className="w-full max-w-[300px]">
          <Orb hot={busy} />
        </div>
        <div className="flex h-[34px] items-center gap-[3px]" aria-hidden="true">
          {HEIGHTS.map((h, i) => (
            <span
              key={i}
              className={cn("block w-[3px] origin-center", busy && "hud-wave")}
              style={{
                height: busy ? 34 : h,
                background: i % 7 === 3 ? "#ff3d8b" : "#2ee9ff",
                opacity: busy ? 1 : 0.45,
                animationDelay: `${(i * 53) % 900}ms`,
              }}
            />
          ))}
        </div>
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
              <span className="border border-[#5a1d3a] bg-neon-magenta/8 px-3.5 py-2.5 font-hud text-[15px] leading-normal whitespace-pre-wrap text-[#fff0f6] select-text">
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
            className="flex flex-col gap-2 border border-neon-magenta bg-neon-magenta/10 px-3 py-2.5 font-mono text-xs text-[#fff0f6]"
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
        {chips.length ? (
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setDraft(c);
                  input.current?.focus();
                }}
                className="min-h-8 cursor-pointer border border-[#1d3347] bg-transparent px-3 py-1.5 font-mono text-[11px] text-hud-soft hover:border-neon-cyan hover:text-hud-ink"
              >
                {c}…
              </button>
            ))}
          </div>
        ) : null}
        <form
          onSubmit={send}
          className="flex items-center gap-2 border border-hud-edge bg-[#070b13] py-1.5 pr-1.5 pl-4 focus-within:border-neon-cyan focus-within:shadow-[0_0_0_1px_#2ee9ff,0_0_24px_rgb(46_233_255/.25)]"
        >
          <span aria-hidden="true" className="font-mono font-bold text-neon-magenta">
            &gt;
          </span>
          <label htmlFor="jev-cmd" className="sr-only">
            Command for Jev
          </label>
          <input
            id="jev-cmd"
            ref={input}
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
