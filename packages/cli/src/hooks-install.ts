import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hasLegacyHooks, removeLegacyHooks } from "./hooks-legacy";

export { hasLegacyHooks, MARKER, removeLegacyHooks } from "./hooks-legacy";

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

/** Where Claude Code keeps its config: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export const defaultClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export type CliRun = { code: number; stdout: string; stderr: string };
/** Runs `claude <args>`; injectable so tests don't need the real CLI. */
export type Claude = (args: string[]) => Promise<CliRun>;

/**
 * The real CLI. CLAUDE_CONFIG_DIR is pinned to claudeDir, except for the default ~/.claude, where it
 * is removed: setting it also moves Claude's global .claude.json, and a stray value in our own env
 * must not redirect the CLI.
 */
export const claudeCli =
  (claudeDir: string): Claude =>
  async (args) => {
    const env = { ...process.env };
    if (resolve(claudeDir) === join(homedir(), ".claude")) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = claudeDir;
    const bin = process.env.CLAUDE_BIN || "claude";
    let proc;
    try {
      proc = Bun.spawn([bin, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

/** Parse CLI JSON output, `fallback` when it is empty or malformed. */
function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Last JSON line of a `--json` run, if any. */
function lastJsonLine(r: CliRun): { outcome?: string; failureCode?: string; message?: string } {
  const line = r.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{"));
  return line ? parseJson(line, {}) : {};
}

/** Failure codes that mean "already in the state we want", for idempotent uninstall. */
const ALREADY_GONE = ["not_installed", "not_configured"];

async function runOk(claude: Claude, args: string[], tolerate: string[] = []) {
  const r = await claude([...args, "--json"]);
  const j = lastJsonLine(r);
  if (r.code === 0 || (j.failureCode && tolerate.includes(j.failureCode))) return;
  throw new Error(`claude ${args.join(" ")}: ${j.message || r.stderr.trim() || `exit ${r.code}`}`);
}

/**
 * Remove the old settings.json hooks. The plugin work is already done when this runs, so a
 * settings.json we refuse to touch (not valid JSON) becomes a warning instead of failing the call.
 */
function cleanLegacy(claudeDir: string): string | null {
  try {
    removeLegacyHooks(claudeDir);
    return null;
  } catch (e) {
    return `could not clean old hooks from settings.json: ${e instanceof Error ? e.message : e}`;
  }
}

export async function installHooks({
  claudeDir,
  port,
  repoRoot = REPO_ROOT,
  claude = claudeCli(claudeDir),
}: Opts & { port: number; repoRoot?: string }): Promise<HooksStatus> {
  await runOk(claude, ["plugin", "marketplace", "add", repoRoot]);
  // Re-installing an installed plugin applies --config, so this also updates the port.
  await runOk(claude, ["plugin", "install", PLUGIN, "--scope", "user", "--config", `port=${port}`]);
  // Disabled in /plugin: install does not necessarily touch that, so turn it back on.
  const before = await hooksStatus({ claudeDir, port, claude });
  if (before.installed && !before.enabled)
    await runOk(claude, ["plugin", "enable", PLUGIN, "--scope", "user"]);
  // Only once the plugin is in, so a failed install leaves the old hooks working.
  const warning = cleanLegacy(claudeDir);
  return { ...(await hooksStatus({ claudeDir, port, claude })), warning };
}

export async function uninstallHooks({
  claudeDir,
  claude = claudeCli(claudeDir),
}: Opts): Promise<HooksStatus> {
  await runOk(claude, ["plugin", "uninstall", PLUGIN, "--scope", "user"], ALREADY_GONE);
  await runOk(claude, ["plugin", "marketplace", "remove", MARKETPLACE], ALREADY_GONE);
  const warning = cleanLegacy(claudeDir);
  return { ...(await hooksStatus({ claudeDir, claude })), warning };
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
  /** The configured port is the given one; false when no port was given. */
  portMatches: boolean;
  /** Set by install/uninstall when the plugin work succeeded but cleaning settings.json did not. */
  warning?: string | null;
};

export async function hooksStatus({
  claudeDir,
  port,
  claude = claudeCli(claudeDir),
}: Opts & { port?: number }): Promise<HooksStatus> {
  let legacy = false;
  try {
    legacy = hasLegacyHooks(claudeDir);
  } catch {
    // unreadable settings.json: nothing to say about old hooks, the plugin state still holds
  }
  const list = await claude(["plugin", "list", "--json"]);
  if (list.code !== 0)
    throw new Error(`claude plugin list: ${list.stderr.trim() || `exit ${list.code}`}`);
  const plugins = parseJson<{ id: string; scope?: string; enabled?: boolean }[]>(
    list.stdout || "[]",
    [],
  );
  // User scope only: it is the scope install and uninstall manage.
  const entry = plugins.find((p) => p.id === PLUGIN && (p.scope ?? "user") === "user");
  let configured: number | null = null;
  if (entry) {
    const c = await claude(["plugin", "configure", PLUGIN, "--json"]);
    if (c.code === 0) {
      const j = parseJson<{
        inputs?: { port?: unknown };
        schema?: { port?: { default?: unknown } };
      }>(c.stdout, {});
      configured = Number(j.inputs?.port ?? j.schema?.port?.default) || null;
    }
  }
  const enabled = !!entry?.enabled;
  const state: HooksState = !entry ? "missing" : enabled && !legacy ? "installed" : "partial";
  return {
    state,
    installed: !!entry,
    enabled,
    legacy,
    port: configured,
    portMatches: port !== undefined && configured === port,
  };
}
