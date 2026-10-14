import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../types";
import { parseHook } from "./events";
import { hooksStatus, installHooks, uninstallHooks } from "./hooks";
import { claudeSpawner } from "./spawner";
import { claudeTranscripts } from "./transcripts";
import { isTrusted, trustAdvice, trustedPaths } from "./trust";

export const CLAUDE_CODE = "claude-code";

/**
 * Claude Code: hooks in `<claudeDir>/settings.json` post to the daemon, transcripts under
 * `<claudeDir>/projects` carry usage, `claude --bg` starts sessions, `~/.claude.json` holds trust.
 *
 * Without `claudeDir` the provider never touches the real Claude dir on its own: no hook install
 * (the admin endpoints answer 501) and no transcript backfill. Transcripts that hooks point at are
 * still read from the default dir, as before.
 */
export function claudeCode({ claudeDir }: { claudeDir?: string } = {}): AgentProvider {
  const dir = claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return {
    id: CLAUDE_CODE,
    name: "Claude Code",
    parseEvent: parseHook,
    transcripts: claudeTranscripts(join(dir, "projects"), !!claudeDir),
    integration: claudeDir
      ? {
          status: ({ port }) => hooksStatus({ claudeDir, port }),
          install: ({ port }) => installHooks({ claudeDir, port }),
          uninstall: () => uninstallHooks({ claudeDir }),
        }
      : undefined,
    spawn: claudeSpawner,
    trust: {
      trusted: trustedPaths,
      isTrusted: (path, trusted) => isTrusted(path, trusted),
      advice: trustAdvice,
    },
  };
}
