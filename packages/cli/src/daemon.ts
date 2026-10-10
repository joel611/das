// The daemon: scans projects, tracks Claude sessions, serves the device/desktop API, routes voice requests.
//   bun run daemon           run in the foreground
//   bun run daemon --bg      run detached (log: <config dir>/daemon.log, pid: <config dir>/daemon.pid)
//   bun run daemon --stop    stop the background daemon
//   bun run daemon --status  show whether it is running
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, configDir } from "./config";
import { defaultClaudeDir } from "./hooks-install";
import { scan, type Project } from "./scanner";
import { createServer } from "./server";
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
  const server = createServer({
    port: config.port,
    token: config.token,
    getProjects: () => projects,
    configDir: dir,
    claudeDir: defaultClaudeDir(),
    onSettings: (c) => {
      Object.assign(config, c);
      rescan();
    },
  });
  console.log(
    `stack-chan daemon on :${server.port}, roots: ${config.roots.join(", ")}, ${projects.length} projects`,
  );
  const advice = trustAdvice(config.roots, projects);
  if (advice) console.warn(advice);
}

const flag = process.argv.slice(2).find((a) => a.startsWith("--"));

if (flag === "--stop") {
  const pid = runningPid();
  if (pid) process.kill(pid, "SIGTERM");
  console.log(pid ? `stopped daemon (pid ${pid})` : "daemon is not running");
} else if (flag === "--status") {
  const pid = runningPid();
  console.log(pid ? `running (pid ${pid}), port ${config.port}, log ${logFile}` : "not running");
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
  console.error(`unknown option ${flag}; use --bg, --stop or --status`);
  process.exit(2);
} else {
  serve();
}
