import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionSource, installOmp, ompStatus, uninstallOmp } from "./omp-extension";

const dirs: string[] = [];
const fresh = () => dirs[dirs.push(mkdtempSync(join(tmpdir(), "omp-"))) - 1];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("install writes the extension, reports port, uninstall removes it", () => {
  const dir = fresh();
  expect(ompStatus({ ompDir: dir, port: 4321 }).state).toBe("missing");
  expect(installOmp({ ompDir: dir, port: 4321 })).toEqual({
    state: "installed",
    portMatches: true,
    port: 4321,
  });
  expect(readFileSync(join(dir, "extensions/das-session.ts"), "utf8")).toBe(extensionSource(4321));
  expect(installOmp({ ompDir: dir, port: 5000 }).port).toBe(5000);
  expect(ompStatus({ ompDir: dir, port: 4321 }).portMatches).toBe(false);
  expect(uninstallOmp({ ompDir: dir }).state).toBe("missing");
  expect(existsSync(join(dir, "extensions/das-session.ts"))).toBe(false);
});

test("a foreign file at the same path is not reported as ours", () => {
  const dir = fresh();
  mkdirSync(join(dir, "extensions"));
  writeFileSync(join(dir, "extensions/das-session.ts"), "export default () => {}");
  expect(ompStatus({ ompDir: dir, port: 1 }).state).toBe("missing");
});

test("generated extension posts omp events as Claude hook events", async () => {
  const seen: [string, unknown][] = [];
  const srv = Bun.serve({
    port: 0,
    fetch: async (r) => {
      seen.push([new URL(r.url).pathname, await r.json()]);
      return new Response(null, { status: 204 });
    },
  });
  const dir = fresh();
  installOmp({ ompDir: dir, port: srv.port! });
  const handlers: Record<string, (e: unknown, c: unknown) => void> = {};
  const mod = await import(join(dir, "extensions/das-session.ts"));
  const saved = process.env.OMPCODE;
  delete process.env.OMPCODE;
  mod.default({ on: (n: string, f: (e: unknown, c: unknown) => void) => (handlers[n] = f) });
  if (saved) process.env.OMPCODE = saved;
  const ctx = { cwd: "/p", sessionManager: { getSessionId: () => "s1" } };
  handlers.agent_start({}, ctx);
  handlers.tool_execution_start({ toolName: "bash" }, ctx);
  handlers.agent_end({ willContinue: true }, ctx);
  handlers.agent_end({}, ctx);
  await Bun.sleep(200);
  srv.stop(true);
  expect(seen).toEqual([
    ["/hooks/UserPromptSubmit", { session_id: "s1", cwd: "/p" }],
    ["/hooks/PreToolUse", { session_id: "s1", cwd: "/p", tool_name: "bash" }],
    ["/hooks/Stop", { session_id: "s1", cwd: "/p" }],
  ]);
});
