import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MARKER, type IntegrationStatus } from "../worker";

/** Installs a das extension into pi's agent dir (`<piDir>/extensions/das-session.ts`). It maps pi events onto the Claude hook events `/hooks/:event` already understands. */

export type PiStatus = IntegrationStatus & { state: "installed" | "missing" };

const fileOf = (piDir: string) => join(piDir, "extensions", "das-session.ts");

export const extensionSource = (
  port: number,
) => `// ${MARKER}: managed by das, reinstall overwrites this file
// @ts-nocheck
const URL_ = "http://127.0.0.1:${port}/hooks/";

export default function (pi) {
  const send = (event, ctx, extra = {}) => {
    let id;
    try { id = ctx?.sessionManager?.getSessionId?.(); } catch {}
    if (!id) return;
    const body = { session_id: id, agent: "pi", cwd: ctx?.cwd ?? process.cwd(), ...extra };
    fetch(URL_ + event, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(2000) }).catch(() => {});
  };
  pi.on("session_start", (_e, ctx) => send("SessionStart", ctx));
  pi.on("agent_start", (_e, ctx) => send("UserPromptSubmit", ctx));
  pi.on("tool_execution_start", (e, ctx) => send("PreToolUse", ctx, { tool_name: e?.toolName }));
  // agent_end can be followed by a retry or queued message; agent_settled fires once pi has nothing left to run.
  pi.on("agent_settled", (_e, ctx) => send("Stop", ctx));
  pi.on("session_shutdown", (_e, ctx) => send("SessionEnd", ctx));
}
`;

export function installPi({ piDir, port }: { piDir: string; port: number }): PiStatus {
  const file = fileOf(piDir);
  const src = extensionSource(port);
  if (!existsSync(file) || readFileSync(file, "utf8") !== src) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, src);
    renameSync(tmp, file);
  }
  return piStatus({ piDir, port });
}

export function uninstallPi({ piDir }: { piDir: string }): PiStatus {
  rmSync(fileOf(piDir), { force: true });
  return piStatus({ piDir, port: 0 });
}

export function piStatus({ piDir, port }: { piDir: string; port: number }): PiStatus {
  const file = fileOf(piDir);
  const src = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!src.includes(MARKER)) return { state: "missing", portMatches: false, port: null };
  const found = Number(src.match(/127\.0\.0\.1:(\d+)\/hooks\//)?.[1]) || null;
  return { state: "installed", portMatches: found === port, port: found };
}
