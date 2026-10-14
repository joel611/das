import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = { roots: string[]; port: number; token: string; openrouterKey: string };

const expand = (p: string) => (p.startsWith("~") ? homedir() + p.slice(1) : p);

export const configDir = (env: Record<string, string | undefined> = process.env) =>
  env.STACKCHAN_CONFIG_DIR ||
  join(homedir(), "Library", "Application Support", "stack-chan-server");

/** Raw persisted settings (what the user saved; env overrides are not included). */
export function readSettingsFile(dir = configDir()): Partial<Config> {
  try {
    const j = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** Merge a patch into the settings file (mode 0600, atomic). */
export function writeSettingsFile(patch: Partial<Config>, dir = configDir()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...readSettingsFile(dir), ...patch }, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Effective config: env vars override the settings file, which overrides defaults. */
export function loadConfig(
  dir = configDir(),
  env: Record<string, string | undefined> = process.env,
): Config {
  const f = readSettingsFile(dir);
  const roots = env.PROJECT_ROOTS
    ? env.PROJECT_ROOTS.split(",")
    : Array.isArray(f.roots)
      ? f.roots
      : ["~/Projects"];
  return {
    roots: roots.map((r) => expand(String(r).trim())).filter(Boolean),
    port: Number(env.PORT || f.port || 5777),
    token: env.TOKEN ?? f.token ?? "",
    openrouterKey: env.OPENROUTER_API_KEY || f.openrouterKey || "",
  };
}

/** Which settings an env var currently pins (file edits to these have no effect). */
export const envOverrides = (env: Record<string, string | undefined> = process.env) =>
  (
    [
      ["roots", "PROJECT_ROOTS"],
      ["port", "PORT"],
      ["token", "TOKEN"],
      ["openrouterKey", "OPENROUTER_API_KEY"],
    ] as const
  ).flatMap(([k, e]) => (env[e] ? [k] : []));

/** Live config of this process; the admin API refreshes it after a save. */
export const config: Config = loadConfig();
