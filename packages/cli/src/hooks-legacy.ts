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
import { dirname, join } from "node:path";

/** Marks the command hooks older versions wrote straight into settings.json. */
export const MARKER = "# stack-chan-server";

// Hooks written straight into settings.json by earlier versions. Only ever removed.

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
