import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Project } from "../../scanner";

/** Claude Code keeps per-folder trust in `~/.claude.json` -> projects[<path>].hasTrustDialogAccepted. */
const claudeJson = () => join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");

export function trustedPaths(file = claudeJson()): string[] {
  try {
    const projects = JSON.parse(readFileSync(file, "utf8")).projects ?? {};
    return Object.keys(projects).filter((k) => projects[k]?.hasTrustDialogAccepted === true);
  } catch {
    return [];
  }
}

/** A folder is trusted if it, or any ancestor, is trusted (checked against `claude --bg`). Trust is never saved for the home dir. */
export function isTrusted(path: string, trusted: string[], home = homedir()): boolean {
  return trusted.some((t) => t !== home && (path === t || path.startsWith(t + sep)));
}

/** Startup advice for projects that `claude --bg` would refuse with "Workspace not trusted", or null if all are fine. */
export function trustAdvice(
  roots: string[],
  projects: Project[],
  trusted = trustedPaths(),
): string | null {
  const bad = projects.filter((p) => !isTrusted(p.path, trusted));
  if (!bad.length) return null;
  const lines = roots.flatMap((root) => {
    const n = bad.filter((p) => p.path === root || p.path.startsWith(root + sep)).length;
    return n ? [`  ${root}: ${n} project(s) not trusted`] : [];
  });
  return [
    `Claude Code does not trust ${bad.length} of ${projects.length} projects, so voice spawns there will fail ("Workspace not trusted"):`,
    ...lines,
    `Fix: run \`claude\` once in the folder and accept the trust dialog. Trust covers all subfolders, so one run in a root folder is enough.`,
    `Trusting a folder also lets project hooks, .mcp.json and allow rules of every repo beneath it run, so pick the narrowest folder that holds only repos you trust.`,
  ].join("\n");
}
