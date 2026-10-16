import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config";

/**
 * Edits Claude Code's user settings (`<claudeDir>/settings.json`, keys `hooks` and `statusLine`).
 * Callers always pass claudeDir explicitly.
 *
 * The status line is how plan limits reach the daemon: Claude Code gives the status line command
 * `rate_limits` (5-hour and weekly percent used, reset times), which hooks never see. A status line the
 * user already had is kept: ours runs its command (base64 in DAS_WRAP_B64), keeps its other fields
 * (padding, refreshInterval), and uninstall puts it back.
 */

export const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;
export const MARKER = "# stack-chan-server";

type Hook = { type?: string; command?: string; [k: string]: unknown };
type Group = { matcher?: string; hooks?: Hook[]; [k: string]: unknown };
type StatusLine = { type?: string; command?: string; [k: string]: unknown };
type Settings = { hooks?: Record<string, Group[]>; statusLine?: StatusLine; [k: string]: unknown };

/** Fire-and-forget: stdin JSON -> local server, no output, always exit 0. */
export const hookCommand = (event: string, port: number) =>
  `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hooks/${event} >/dev/null 2>&1 || true ${MARKER}`;

/** The relay script that ships next to this package's src/. */
export const STATUSLINE_SCRIPT = join(import.meta.dir, "..", "statusline.sh");
const sq = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

/**
 * Where settings.json points: a copy in the das config dir, not the checkout (which may be a worktree or
 * move), since a missing script would also take down the user's wrapped status line.
 */
export const installedScript = (scriptDir = configDir()) => join(scriptDir, "statusline.sh");

/** Our status line command; `wrapped` is the command of the user's previous status line, if any. */
export const statusLineCommand = (port: number, wrapped?: string, script = installedScript()) =>
  `${wrapped ? `DAS_WRAP_B64=${Buffer.from(wrapped).toString("base64")} ` : ""}sh ${sq(script)} ${port} ${MARKER}`;

const isOurStatusLine = (sl: StatusLine | undefined): boolean =>
  typeof sl?.command === "string" && sl.command.includes(MARKER);
const wrappedOf = (sl: StatusLine): string | undefined => {
  const b64 = sl.command?.match(/DAS_WRAP_B64=([A-Za-z0-9+/=]+)/)?.[1];
  return b64 ? Buffer.from(b64, "base64").toString("utf8") : undefined;
};
const statusLineScript = (sl: StatusLine) => sl.command?.match(/sh '([^']*)' \d+ /)?.[1];
const statusLinePort = (sl: StatusLine) =>
  Number(sl.command?.match(/statusline\.sh'? (\d+) /)?.[1]) || null;

const isOurs = (h: Hook) =>
  h?.type === "command" && typeof h.command === "string" && h.command.includes(MARKER);
const portOf = (h: Hook) => Number(h.command?.match(/127\.0\.0\.1:(\d+)\/hooks\//)?.[1]) || null;

/** Resolve through symlinks (the real ~/.claude may link into a dotfiles repo); a missing file resolves to its real dir. */
function target(claudeDir: string): string {
  const file = join(claudeDir, "settings.json");
  if (existsSync(file)) return realpathSync(file);
  mkdirSync(claudeDir, { recursive: true });
  return join(realpathSync(claudeDir), "settings.json");
}

function read(file: string): Settings {
  if (!existsSync(file)) return {};
  const s = JSON.parse(readFileSync(file, "utf8"));
  if (!s || typeof s !== "object" || Array.isArray(s))
    throw new Error(`${file} is not a JSON object`);
  if (
    s.hooks !== undefined &&
    (typeof s.hooks !== "object" || s.hooks === null || Array.isArray(s.hooks))
  )
    throw new Error(`${file}: "hooks" is not an object`);
  return s;
}

/** Backup, then atomic write (tmp file in the same dir, renamed onto the resolved target). */
function write(file: string, s: Settings) {
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  }
  const tmp = join(dirname(file), `.settings.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  if (existsSync(file)) chmodSync(tmp, statSync(file).mode & 0o777);
  renameSync(tmp, file);
}

/** Remove our hooks from one event's groups (except `keep`); prune groups and events we emptied. Returns whether anything changed. */
function strip(hooks: Record<string, Group[]>, event: string, keep?: Hook): boolean {
  const groups = hooks[event];
  if (!Array.isArray(groups)) return false;
  let changed = false;
  hooks[event] = groups.filter((g) => {
    if (!Array.isArray(g?.hooks)) return true;
    const before = g.hooks.length;
    g.hooks = g.hooks.filter((h) => !isOurs(h) || h === keep);
    if (g.hooks.length === before) return true;
    changed = true;
    return g.hooks.length > 0;
  });
  if (changed && !hooks[event].length) delete hooks[event];
  return changed;
}

export function installHooks({
  claudeDir,
  port,
  scriptDir,
}: {
  claudeDir: string;
  port: number;
  scriptDir?: string;
}) {
  const file = target(claudeDir);
  const s = read(file);
  const before = JSON.stringify(s);
  const hooks = (s.hooks ??= {});
  for (const ev of EVENTS) {
    const cmd = hookCommand(ev, port);
    const groups = (hooks[ev] ??= []);
    const existing = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).find(isOurs);
    if (existing) {
      existing.command = cmd;
      strip(hooks, ev, existing); // drop duplicates
    } else {
      groups.push({ hooks: [{ type: "command", command: cmd }] });
    }
  }
  // Wrap a status line the user has (keeping its padding and refreshInterval); re-install keeps what we wrapped.
  const prev = s.statusLine;
  const wrapped = prev && isOurStatusLine(prev) ? wrappedOf(prev) : prev?.command;
  const script = installedScript(scriptDir);
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(STATUSLINE_SCRIPT, script);
  s.statusLine = { ...prev, type: "command", command: statusLineCommand(port, wrapped, script) };
  if (JSON.stringify(s) !== before) write(file, s);
  return hooksStatus({ claudeDir, port });
}

export function uninstallHooks({ claudeDir }: { claudeDir: string }) {
  const file = target(claudeDir);
  const s = read(file);
  let changed = false;
  if (s.hooks) {
    for (const ev of Object.keys(s.hooks)) changed = strip(s.hooks, ev) || changed;
    if (changed && !Object.keys(s.hooks).length) delete s.hooks;
  }
  if (s.statusLine && isOurStatusLine(s.statusLine)) {
    const wrapped = wrappedOf(s.statusLine);
    if (wrapped) s.statusLine = { ...s.statusLine, command: wrapped };
    else delete s.statusLine;
    changed = true;
  }
  if (changed) write(file, s);
  return hooksStatus({ claudeDir, port: 0 });
}

export type EventStatus = "installed" | "partial" | "missing";
export type HooksStatus = {
  state: EventStatus;
  events: Record<string, EventStatus>;
  portMatches: boolean;
  port: number | null;
};

export function hooksStatus({ claudeDir, port }: { claudeDir: string; port: number }): HooksStatus {
  const s = read(target(claudeDir));
  const events: Record<string, EventStatus> = {};
  const ports = new Set<number | null>();
  for (const ev of EVENTS) {
    const ours = (Array.isArray(s.hooks?.[ev]) ? s.hooks![ev] : [])
      .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
      .filter(isOurs);
    ours.forEach((h) => ports.add(portOf(h)));
    events[ev] = !ours.length
      ? "missing"
      : ours.length > 1 || ours.some((h) => portOf(h) !== port)
        ? "partial"
        : "installed";
  }
  if (s.statusLine && isOurStatusLine(s.statusLine)) {
    const p = statusLinePort(s.statusLine);
    ports.add(p);
    const script = statusLineScript(s.statusLine);
    events.StatusLine = p === port && script && existsSync(script) ? "installed" : "partial";
  } else events.StatusLine = "missing";
  const vals = Object.values(events);
  const state = vals.every((v) => v === "missing")
    ? "missing"
    : vals.every((v) => v === "installed")
      ? "installed"
      : "partial";
  return {
    state,
    events,
    portMatches: ports.size === 1 && ports.has(port),
    port: ports.size === 1 ? [...ports][0] : null,
  };
}
