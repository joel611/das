import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Installs the Claude Code hooks as a plugin (`plugins/stack-chan-hooks`, listed by the
 * repo's own marketplace in `.claude-plugin/marketplace.json`) through the `claude plugin`
 * CLI, instead of editing the `hooks` key of Claude's settings.json ourselves.
 */

export const MARKETPLACE = "stack-chan";
export const PLUGIN = `stack-chan-hooks@${MARKETPLACE}`;
/** The marketplace root: this repository (packages/cli/src -> repo root). */
export const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** Events the plugin's hooks/hooks.json forwards. */
export const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;
/** Marks the command hooks older versions wrote straight into settings.json. */
export const MARKER = "# stack-chan-server";

export type Run = { code: number; stdout: string; stderr: string };
/** Runs `claude <args>`; injectable so tests don't need the real CLI. */
export type Claude = (args: string[], stdin?: string) => Promise<Run>;

/** The real CLI. CLAUDE_CONFIG_DIR is only set when claudeDir is not the default ~/.claude. */
export const claudeCli =
  (claudeDir: string): Claude =>
  async (args, stdin) => {
    const env = { ...process.env };
    if (resolve(claudeDir) !== join(homedir(), ".claude")) env.CLAUDE_CONFIG_DIR = claudeDir;
    const bin = process.env.CLAUDE_BIN || "claude";
    let proc;
    try {
      proc = Bun.spawn([bin, ...args], {
        env,
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      throw new Error(
        `could not run "${bin}": is Claude Code installed and on PATH? (or set CLAUDE_BIN)`,
      );
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };

type Opts = { claudeDir: string; claude?: Claude };

/** Last JSON line of a `--json` run, if any. */
function result(r: Run): { outcome?: string; failureCode?: string; message?: string } {
  const line = r.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{"));
  try {
    return line ? JSON.parse(line) : {};
  } catch {
    return {};
  }
}

async function must(claude: Claude, args: string[], ok: string[] = []) {
  const r = await claude([...args, "--json"]);
  const j = result(r);
  if (r.code === 0 || (j.failureCode && ok.includes(j.failureCode))) return;
  throw new Error(`claude ${args.join(" ")}: ${j.message || r.stderr.trim() || `exit ${r.code}`}`);
}

export async function installHooks({
  claudeDir,
  port,
  repoRoot = REPO_ROOT,
  claude = claudeCli(claudeDir),
}: Opts & { port: number; repoRoot?: string }) {
  await must(claude, ["plugin", "marketplace", "add", repoRoot]);
  // Re-installing an installed plugin is a no-op apart from applying --config, so this also updates the port.
  await must(claude, ["plugin", "install", PLUGIN, "--scope", "user", "--config", `port=${port}`]);
  // Only once the plugin is in, so a failed install leaves the old hooks working.
  removeLegacyHooks(claudeDir);
  return hooksStatus({ claudeDir, port, claude });
}

export async function uninstallHooks({ claudeDir, claude = claudeCli(claudeDir) }: Opts) {
  removeLegacyHooks(claudeDir);
  await must(claude, ["plugin", "uninstall", PLUGIN, "--scope", "user"], ["not_installed"]);
  await must(claude, ["plugin", "marketplace", "remove", MARKETPLACE], ["not_configured"]);
  return hooksStatus({ claudeDir, port: 0, claude });
}

export type HooksState = "installed" | "partial" | "missing";
export type HooksStatus = {
  state: HooksState;
  /** The plugin is installed (user scope). */
  installed: boolean;
  enabled: boolean;
  /** Hooks an older version wrote into settings.json are still there; install or uninstall removes them. */
  legacy: boolean;
  /** Port the plugin is configured for, null when not installed. */
  port: number | null;
  portMatches: boolean;
};

export async function hooksStatus({
  claudeDir,
  port,
  claude = claudeCli(claudeDir),
}: Opts & { port: number }): Promise<HooksStatus> {
  const legacy = hasLegacyHooks(claudeDir);
  const list = await claude(["plugin", "list", "--json"]);
  if (list.code !== 0)
    throw new Error(`claude plugin list: ${list.stderr.trim() || `exit ${list.code}`}`);
  const entry = (
    JSON.parse(list.stdout || "[]") as { id: string; scope?: string; enabled?: boolean }[]
  ).find((p) => p.id === PLUGIN && (p.scope ?? "user") === "user");
  let configured: number | null = null;
  if (entry) {
    const c = await claude(["plugin", "configure", PLUGIN, "--json"]);
    if (c.code === 0) {
      const j = JSON.parse(c.stdout);
      configured = Number(j.inputs?.port ?? j.schema?.port?.default) || null;
    }
  }
  const enabled = !!entry?.enabled;
  const state: HooksState =
    enabled && !legacy ? "installed" : entry || legacy ? "partial" : "missing";
  return {
    state,
    installed: !!entry,
    enabled,
    legacy,
    port: configured,
    portMatches: configured === port,
  };
}

// --- Legacy: hooks written straight into settings.json by earlier versions. Only ever removed. ---

type Hook = { type?: string; command?: string; [k: string]: unknown };
type Group = { matcher?: string; hooks?: Hook[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

const isOurs = (h: Hook) =>
  h?.type === "command" && typeof h.command === "string" && h.command.includes(MARKER);

/** Resolve through symlinks (the real ~/.claude may link into a dotfiles repo). */
function settingsFile(claudeDir: string): string | null {
  const file = join(claudeDir, "settings.json");
  return existsSync(file) ? realpathSync(file) : null;
}

function read(file: string): Settings {
  const s = JSON.parse(readFileSync(file, "utf8"));
  if (!s || typeof s !== "object" || Array.isArray(s))
    throw new Error(`${file} is not a JSON object`);
  return s;
}

const groupsOf = (s: Settings) =>
  s.hooks && typeof s.hooks === "object" && !Array.isArray(s.hooks) ? s.hooks : {};

export function hasLegacyHooks(claudeDir: string): boolean {
  const file = settingsFile(claudeDir);
  if (!file) return false;
  return Object.values(groupsOf(read(file))).some(
    (groups) =>
      Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs)),
  );
}

/** Remove our marked hooks and the groups/events that leaves empty. Backup, then atomic write; untouched when nothing changes. */
export function removeLegacyHooks(claudeDir: string): boolean {
  const file = settingsFile(claudeDir);
  if (!file) return false;
  const s = read(file);
  const hooks = groupsOf(s);
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    let touched = false;
    hooks[event] = groups.filter((g) => {
      if (!Array.isArray(g?.hooks)) return true;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !isOurs(h));
      if (g.hooks.length === before) return true;
      touched = true;
      return g.hooks.length > 0;
    });
    if (touched && !hooks[event].length) delete hooks[event];
    changed ||= touched;
  }
  if (!changed) return false;
  if (!Object.keys(hooks).length) delete s.hooks;
  copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const tmp = join(dirname(file), `.settings.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  chmodSync(tmp, statSync(file).mode & 0o777);
  renameSync(tmp, file);
  return true;
}
