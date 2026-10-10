// Claude Code hook plugin, from the shell:
//   bun run hooks:install     add this repo as a plugin marketplace and install stack-chan-hooks for the saved port
//   bun run hooks:uninstall   uninstall the plugin and remove the marketplace
//   bun run hooks:status      show what is installed
// Also removes hooks that older versions wrote straight into settings.json.
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { hooksStatus, installHooks, uninstallHooks } from "./hooks-install";

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const port = config.port;
const cmd = process.argv[2];

try {
  const status =
    cmd === "install"
      ? await installHooks({ claudeDir, port })
      : cmd === "uninstall"
        ? await uninstallHooks({ claudeDir })
        : cmd === "status"
          ? await hooksStatus({ claudeDir, port })
          : null;
  if (!status) {
    console.error("usage: bun run hooks:install | hooks:uninstall | hooks:status");
    process.exit(2);
  }
  console.log(
    status.installed
      ? `stack-chan-hooks installed (${status.enabled ? "enabled" : "disabled"}), port ${status.port}` +
          (status.portMatches ? "" : ` (daemon port is ${port}: run bun run hooks:install)`)
      : "stack-chan-hooks not installed",
  );
  if (status.legacy)
    console.log("old hooks in settings.json remain: install or uninstall removes them");
  if (cmd !== "status")
    console.log("Restart running Claude sessions (or run /reload-plugins) to apply.");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
