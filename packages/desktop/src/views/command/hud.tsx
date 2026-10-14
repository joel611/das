import type { ReactNode } from "react";

import { hud } from "@/lib/neon-theme";
import { cn } from "@/lib/utils";
import type { SessionState } from "@/lib/types";

/** Neon colour per session state, as Tailwind classes, plus a theme colour reference for box-shadow. */
export const STATE_COLOR: Record<
  SessionState,
  { text: string; bg: string; border: string; glow: string }
> = {
  running: {
    text: "text-neon-cyan",
    bg: "bg-neon-cyan",
    border: "border-neon-cyan",
    glow: hud["neon-cyan"],
  },
  waiting: {
    text: "text-neon-amber",
    bg: "bg-neon-amber",
    border: "border-neon-amber",
    glow: hud["neon-amber"],
  },
  error: {
    text: "text-neon-pink",
    bg: "bg-neon-magenta",
    border: "border-neon-magenta",
    glow: hud["neon-magenta"],
  },
  done: {
    text: "text-neon-green",
    bg: "bg-neon-green",
    border: "border-neon-green",
    glow: hud["neon-green"],
  },
  idle: {
    text: "text-hud-dim",
    bg: "bg-hud-idle",
    border: "border-hud-idle",
    glow: hud["hud-idle"],
  },
};

/** Most urgent first. */
export const URGENCY: SessionState[] = ["error", "waiting", "running", "done", "idle"];

export function Panel({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.ComponentProps<"div">) {
  return (
    <div className={cn("hud border border-hud-line bg-hud-panel", className)} {...props}>
      {children}
    </div>
  );
}

export function PanelTitle({
  id,
  tone = "cyan",
  children,
}: {
  id?: string;
  tone?: "cyan" | "magenta";
  children: ReactNode;
}) {
  return (
    <h2
      id={id}
      className={cn(
        "m-0 font-hud text-[13px] font-semibold tracking-[.24em]",
        tone === "cyan" ? "text-neon-cyan" : "text-neon-magenta",
      )}
    >
      {children}
    </h2>
  );
}

/** A thin meter; `pct` is 0-100. */
export function Bar({
  pct,
  className,
  h = "h-1",
}: {
  pct: number;
  className?: string;
  h?: string;
}) {
  return (
    <span className={cn("block bg-hud-track", h)}>
      <span
        className={cn("block", h, className)}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </span>
  );
}
