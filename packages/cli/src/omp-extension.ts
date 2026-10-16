import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MARKER } from "./hooks-install";

/** Installs a das extension into oh-my-pi's agent dir (`<ompDir>/extensions/das-session.ts`). It maps omp events onto the Claude hook events `/hooks/:event` already understands. */

export type OmpStatus = {
  state: "installed" | "missing";
  portMatches: boolean;
  port: number | null;
};

const fileOf = (ompDir: string) => join(ompDir, "extensions", "das-session.ts");

export const extensionSource = (
  port: number,
) => `// ${MARKER}: managed by das, reinstall overwrites this file
// @ts-nocheck
const URL_ = "http://127.0.0.1:${port}/hooks/";

export default function (pi) {
  // omp marks every shell it spawns with OMPCODE=1, so a nested omp is not a root session.
  if (process.env.OMPCODE === "1") return;
  const send = (event, ctx, extra = {}) => {
    let id;
    try { id = ctx?.sessionManager?.getSessionId?.(); } catch {}
    if (!id) return;
    const body = { session_id: id, agent: "omp", cwd: ctx?.cwd ?? process.cwd(), ...extra };
    fetch(URL_ + event, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(2000) }).catch(() => {});
  };
  pi.on("session_start", (_e, ctx) => send("SessionStart", ctx));
  pi.on("agent_start", (_e, ctx) => send("UserPromptSubmit", ctx));
  pi.on("tool_execution_start", (e, ctx) => send("PreToolUse", ctx, { tool_name: e?.toolName }));
  pi.on("tool_approval_requested", (e, ctx) =>
    send("Notification", ctx, { message: e?.reason || (e?.toolName || "Tool") + " approval" }));
  pi.on("agent_end", (e, ctx) => { if (e?.willContinue !== true) send("Stop", ctx); });
  pi.on("session_shutdown", (_e, ctx) => send("SessionEnd", ctx));
}
`;

export function installOmp({ ompDir, port }: { ompDir: string; port: number }): OmpStatus {
  const file = fileOf(ompDir);
  const src = extensionSource(port);
  if (!existsSync(file) || readFileSync(file, "utf8") !== src) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, src);
    renameSync(tmp, file);
  }
  return ompStatus({ ompDir, port });
}

export function uninstallOmp({ ompDir }: { ompDir: string }): OmpStatus {
  rmSync(fileOf(ompDir), { force: true });
  return ompStatus({ ompDir, port: 0 });
}

export function ompStatus({ ompDir, port }: { ompDir: string; port: number }): OmpStatus {
  const file = fileOf(ompDir);
  const src = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!src.includes(MARKER)) return { state: "missing", portMatches: false, port: null };
  const found = Number(src.match(/127\.0\.0\.1:(\d+)\/hooks\//)?.[1]) || null;
  return { state: "installed", portMatches: found === port, port: found };
}
