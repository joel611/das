import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  roots: string[];
  port: number;
  token: string;
  openrouterKey: string;
  usageApi: boolean;
  /** Stack-chan beeps when a session enters waiting, done or error. */
  notificationSound: boolean;
  /** Who routes desktop and voice requests: the Jev classifiers alone, or the durable pi orchestrator. Restart to switch. */
  orchestrator: "jev" | "pi";
  /**
   * Where the orchestrator's model runs: OpenRouter with `openrouterKey`, or OpenAI with the ChatGPT
   * subscription you signed in to with `codex login`, read from Codex's auth.json.
   */
  orchestratorProvider: "openrouter" | "openai";
  /** Model id for that provider; empty uses the provider's default. */
  orchestratorModel: string;
  /** Where the Jev routing classifiers run; same providers as the orchestrator. */
  classifierProvider: "openrouter" | "openai";
  /** Model id for that provider; empty uses the provider's default. */
  classifierModel: string;
  /** Codex's login file for the `openai` provider; empty uses `~/.codex/auth.json`. */
  codexAuthFile: string;
};

export const DEFAULT_CLASSIFIER_MODELS: Record<Config["classifierProvider"], string> = {
  openrouter: "typesafe/jev-1.13",
  openai: "gpt-6-luna",
};

export const DEFAULT_ORCHESTRATOR_MODELS: Record<Config["orchestratorProvider"], string> = {
  openrouter: "anthropic/claude-haiku-5.5",
  openai: "gpt-6-luna",
};

const expand = (p: string) => (p.startsWith("~") ? homedir() + p.slice(1) : p);

export const configDir = (env: Record<string, string | undefined> = process.env) =>
  env.DAS_CONFIG_DIR || join(homedir(), ".config", "das");

const FILE = "config.yml";

/**
 * Raw persisted settings (what the user saved; env overrides are not included).
 * A missing file is `{}`; a file that exists but is not a YAML mapping throws, naming the file.
 */
export function readSettingsFile(dir = configDir()): Partial<Config> {
  const file = join(dir, FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`cannot read ${file}: ${e?.message ?? e}`);
  }
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e: any) {
    throw new Error(`malformed ${file}: ${e?.message ?? e}`);
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`malformed ${file}: expected a mapping of settings`);
  return doc as Partial<Config>;
}

/** Merge a patch into the settings file (mode 0600, atomic). Comments in the file are dropped. */
export function writeSettingsFile(patch: Partial<Config>, dir = configDir()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, Bun.YAML.stringify({ ...readSettingsFile(dir), ...patch }, null, 2) + "\n", {
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
    // Unlike the rest, a saved key beats the env var: env is only the default.
    openrouterKey: f.openrouterKey || env.OPENROUTER_API_KEY || "",
    usageApi: env.DAS_USAGE_API ? env.DAS_USAGE_API === "1" : f.usageApi === true,
    notificationSound: f.notificationSound === true,
    orchestrator: (env.DAS_ORCHESTRATOR || f.orchestrator) === "pi" ? "pi" : "jev",
    orchestratorProvider:
      (env.DAS_ORCHESTRATOR_PROVIDER || f.orchestratorProvider) === "openai"
        ? "openai"
        : "openrouter",
    orchestratorModel: env.DAS_ORCHESTRATOR_MODEL || f.orchestratorModel || "",
    classifierProvider:
      (env.DAS_CLASSIFIER_PROVIDER || f.classifierProvider) === "openai" ? "openai" : "openrouter",
    classifierModel: env.DAS_CLASSIFIER_MODEL || f.classifierModel || "",
    codexAuthFile: expand(env.DAS_CODEX_AUTH_FILE || f.codexAuthFile || ""),
  };
}

/**
 * Re-read the settings for a running daemon. The listening port never changes live:
 * a changed port is reported as `restartRequired` and the bound one is kept.
 * A malformed file leaves the caller's config untouched.
 */
export function reloadConfig(
  current: Config,
  dir = configDir(),
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: Config; restartRequired: boolean } | { ok: false; error: string } {
  try {
    const next = loadConfig(dir, env);
    return {
      ok: true,
      config: { ...next, port: current.port },
      restartRequired: next.port !== current.port,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Where the effective OpenRouter key comes from: the saved setting, the env default, or nowhere. */
export const openrouterKeySource = (
  dir = configDir(),
  env: Record<string, string | undefined> = process.env,
): "settings" | "env" | "none" =>
  readSettingsFile(dir).openrouterKey ? "settings" : env.OPENROUTER_API_KEY ? "env" : "none";

/** Which settings an env var currently pins (file edits to these have no effect). */
export const envOverrides = (env: Record<string, string | undefined> = process.env) =>
  (
    [
      ["roots", "PROJECT_ROOTS"],
      ["port", "PORT"],
      ["token", "TOKEN"],
      ["usageApi", "DAS_USAGE_API"],
      ["orchestrator", "DAS_ORCHESTRATOR"],
      ["orchestratorProvider", "DAS_ORCHESTRATOR_PROVIDER"],
      ["orchestratorModel", "DAS_ORCHESTRATOR_MODEL"],
      ["classifierProvider", "DAS_CLASSIFIER_PROVIDER"],
      ["classifierModel", "DAS_CLASSIFIER_MODEL"],
      ["codexAuthFile", "DAS_CODEX_AUTH_FILE"],
    ] as const
  ).flatMap(([k, e]) => (env[e] ? [k] : []));

/** Live config of this process; the admin API refreshes it after a save. */
export const config: Config = loadConfig();
