import { defineConfig } from "vite-plus";

// `vp run` starts tasks with a clean environment, so the vars the daemon reads
// (config.ts, router.ts, ...) must be listed here or `bun run dev` never sees them.
const daemonEnv = [
  "ACT_THRESHOLD",
  "ASK_THRESHOLD",
  "CLAUDE_BIN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "DAS_CODEX_AUTH_FILE",
  "DAS_CONFIG_DIR",
  "DAS_ORCHESTRATOR",
  "DAS_ORCHESTRATOR_MODEL",
  "DAS_ORCHESTRATOR_PROVIDER",
  "DAS_USAGE_API",
  "DECISIONS_LOG",
  "INTENT_THRESHOLD",
  "OMPCODE",
  "OPENROUTER_API_KEY",
  "PI_BIN",
  "PI_CODING_AGENT_DIR",
  "PORT",
  "PROJECT_ROOTS",
  "TOKEN",
];

export default defineConfig({
  run: {
    tasks: {
      "dev:all": { command: "bun run dev", cache: { untrackedEnv: daemonEnv } },
    },
  },
});
