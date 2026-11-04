import type { Integration, Worker } from "../worker";
import { hooksStatus, installHooks, uninstallHooks } from "./hooks-install";
import { cancelClaude, sendClaude, spawnClaude } from "./spawn";

/** Claude Code: `claude --bg --worktree`, hooks in `<claudeDir>/settings.json`. */
export function createClaudeWorker({ dir }: { dir?: string } = {}): Worker {
  const integration: Integration | undefined = dir
    ? {
        status: (port) => hooksStatus({ claudeDir: dir, port }),
        install: (port) => installHooks({ claudeDir: dir, port }),
        uninstall: () => uninstallHooks({ claudeDir: dir }),
      }
    : undefined;
  return { id: "claude", spawn: spawnClaude, send: sendClaude, cancel: cancelClaude, integration };
}
