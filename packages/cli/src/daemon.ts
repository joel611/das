// The daemon: scans projects, tracks Claude sessions, serves the device/desktop API, routes voice requests.
//   bun run daemon           run in the foreground
//   bun run daemon --bg      run detached (output: <config dir>/daemon.log, pid: <config dir>/daemon.pid)
//   ws.log and api.log (JSON lines, rotated) live in <config dir>/logs
//   bun run daemon --stop    stop the background daemon
//   bun run daemon --reload  re-read config.yml in the running daemon (SIGHUP)
//   bun run daemon --status  show whether it is running
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config, configDir, reloadConfig } from "./config";
import { createLogs, logsLocation } from "./logs";
import { scan, type Project } from "./scanner";
import { createServer } from "./api/server";
import { startPiOrchestrator } from "./orchestrator-start";
import { trustAdvice } from "./trust";

const dir = configDir();
const pidFile = join(dir, "daemon.pid");
const logFile = join(dir, "daemon.log");

function runningPid(): number | null {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    process.kill(pid, 0); // throws if the process is gone
    return pid;
  } catch {
    return null;
  }
}

function serve() {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  const cleanup = () => {
    if (readFileSync(pidFile, "utf8") === String(process.pid)) rmSync(pidFile, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  let projects: Project[] = [];
  const rescan = () => (projects = scan(config.roots));
  rescan();
  setInterval(rescan, 60_000);
  process.on("SIGHUP", () => {
    const r = reloadConfig(config);
    if (!r.ok) {
      console.error(`reload failed, keeping previous config: ${r.error}`);
      return;
    }
    Object.assign(config, r.config);
    rescan();
    console.log(`config reloaded from ${join(dir, "config.yml")}`);
    if (r.restartRequired) {
      console.warn(`port changed in config: restart required (still listening on :${config.port})`);
    }
  });
  const server = createServer({
    port: config.port,
    token: config.token,
    getToken: () => config.token,
    logs: createLogs(dir),
    getProjects: () => projects,
    configDir: dir,
    claudeDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    ompDir: process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"),
    usageApi: () => config.usageApi,
    soundEnabled: () => config.notificationSound,
    // Read once: switching the orchestrator takes a restart.
    orchestrator:
      config.orchestrator === "pi"
        ? ({ getSessions }) =>
            startPiOrchestrator({ dir, getProjects: () => projects, getSessions })
        : undefined,
    onSettings: (c) => {
      Object.assign(config, c);
      rescan();
    },
  });
  console.log(
    `stack-chan daemon on :${server.port}, roots: ${config.roots.join(", ")}, ${projects.length} projects, orchestrator: ${config.orchestrator}`,
  );
  const advice = trustAdvice(config.roots, projects);
  if (advice) console.warn(advice);
}

const flag = process.argv.slice(2).find((a) => a.startsWith("--"));

if (flag === "--stop") {
  const pid = runningPid();
  if (pid) process.kill(pid, "SIGTERM");
  console.log(pid ? `stopped daemon (pid ${pid})` : "daemon is not running");
} else if (flag === "--reload") {
  const pid = runningPid();
  if (pid) process.kill(pid, "SIGHUP");
  console.log(pid ? `reload requested (pid ${pid})` : "daemon is not running");
  process.exit(pid ? 0 : 1);
} else if (flag === "--status") {
  const pid = runningPid();
  const l = logsLocation(dir);
  console.log(pid ? `running (pid ${pid}), port ${config.port}` : "not running");
  console.log(`config: ${join(dir, "config.yml")}`);
  console.log(`logs:   ${l.api}, ${l.ws}`);
  console.log(`daemon output (--bg stdout/stderr): ${logFile}`);
  process.exit(pid ? 0 : 1);
} else if (flag === "--bg") {
  const pid = runningPid();
  if (pid) {
    console.log(`daemon already running (pid ${pid})`);
  } else {
    mkdirSync(dir, { recursive: true });
    const log = openSync(logFile, "a");
    const child = Bun.spawn([process.execPath, import.meta.path], {
      stdin: "ignore",
      stdout: log,
      stderr: log,
      detached: true,
    });
    child.unref();
    closeSync(log);
    console.log(
      `daemon started in the background (pid ${child.pid}), port ${config.port}, log ${logFile}`,
    );
  }
} else if (flag) {
  console.error(`unknown option ${flag}; use --bg, --stop, --reload or --status`);
  process.exit(2);
} else {
  serve();
}
