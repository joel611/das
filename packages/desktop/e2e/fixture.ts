import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const TOKEN = "e2e-token";
const DAEMON_ENTRY = resolve(import.meta.dirname, "../../cli/src/daemon.ts");

export type Sandbox = { dir: string; configDir: string; roots: [string, string]; port: number };

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

/** Isolated config, Claude and omp dirs plus a free port, exported through env so both the daemon and the app's Rust relay see them. */
export async function createSandbox(): Promise<Sandbox> {
  const dir = mkdtempSync(join(tmpdir(), "das-e2e-"));
  const configDir = join(dir, "config");
  const roots: [string, string] = [join(dir, "projects-a"), join(dir, "projects-b")];
  mkdirSync(configDir);
  for (const r of roots) mkdirSync(r);
  writeFileSync(join(configDir, "config.yml"), `roots:\n  - ${roots[0]}\n`);
  const port = await freePort();
  Object.assign(process.env, {
    DAS_CONFIG_DIR: configDir,
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
    PI_CODING_AGENT_DIR: join(dir, "omp"),
    PORT: String(port),
    TOKEN,
  });
  delete process.env.PROJECT_ROOTS;
  return { dir, configDir, roots, port };
}

export async function startDaemon(): Promise<ChildProcess> {
  const child = spawn("bun", [DAEMON_ENTRY], { env: process.env, stdio: "inherit" });
  const url = `http://127.0.0.1:${process.env.PORT}/v1/state`;
  for (let i = 0; i < 100; i++) {
    const up = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
      .then((r) => r.ok)
      .catch(() => false);
    if (up) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("fixture daemon did not start");
}

/** Stand-in for the daemon: serves canned JSON per path on the sandbox port, 404 for the rest. Close it with the returned fn. */
export async function startMockApi(routes: Record<string, unknown>): Promise<() => Promise<void>> {
  const server = createHttpServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const hit = path in routes;
    res.writeHead(hit ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(hit ? routes[path] : { error: "not mocked" }));
  });
  await new Promise<void>((ok) => server.listen(Number(process.env.PORT), "127.0.0.1", ok));
  return () => new Promise((ok) => server.close(() => ok()));
}

export async function stopDaemon(child: ChildProcess) {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
}
