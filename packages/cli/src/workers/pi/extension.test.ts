import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionSource, installPi, piStatus, uninstallPi } from "./extension";

const dirs: string[] = [];
const fresh = () => dirs[dirs.push(mkdtempSync(join(tmpdir(), "pi-"))) - 1];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("install writes the extension, reports port, uninstall removes it", () => {
  const dir = fresh();
  expect(piStatus({ piDir: dir, port: 4321 }).state).toBe("missing");
  expect(installPi({ piDir: dir, port: 4321 })).toEqual({
    state: "installed",
    portMatches: true,
    port: 4321,
  });
  expect(readFileSync(join(dir, "extensions/das-session.ts"), "utf8")).toBe(extensionSource(4321));
  expect(installPi({ piDir: dir, port: 5000 }).port).toBe(5000);
  expect(piStatus({ piDir: dir, port: 4321 }).portMatches).toBe(false);
  expect(uninstallPi({ piDir: dir }).state).toBe("missing");
  expect(existsSync(join(dir, "extensions/das-session.ts"))).toBe(false);
});

test("a foreign file at the same path is not reported as ours", () => {
  const dir = fresh();
  mkdirSync(join(dir, "extensions"));
  writeFileSync(join(dir, "extensions/das-session.ts"), "export default () => {}");
  expect(piStatus({ piDir: dir, port: 1 }).state).toBe("missing");
});

test("generated extension posts pi events as Claude hook events", async () => {
  const seen: [string, unknown][] = [];
  const srv = Bun.serve({
    port: 0,
    fetch: async (r) => {
      seen.push([new URL(r.url).pathname, await r.json()]);
      return new Response(null, { status: 204 });
    },
  });
  const dir = fresh();
  installPi({ piDir: dir, port: srv.port! });
  const handlers: Record<string, (e: unknown, c: unknown) => void> = {};
  const mod = await import(join(dir, "extensions/das-session.ts"));
  mod.default({ on: (n: string, f: (e: unknown, c: unknown) => void) => (handlers[n] = f) });
  const ctx = { cwd: "/p", sessionManager: { getSessionId: () => "s1" } };
  handlers.agent_start({}, ctx);
  handlers.tool_execution_start({ toolName: "bash" }, ctx);
  handlers.agent_end?.({}, ctx); // not subscribed: a run that retries is not done
  handlers.agent_settled({}, ctx);
  await Bun.sleep(200);
  srv.stop(true);
  expect(seen).toEqual([
    ["/hooks/UserPromptSubmit", { session_id: "s1", agent: "pi", cwd: "/p" }],
    ["/hooks/PreToolUse", { session_id: "s1", agent: "pi", cwd: "/p", tool_name: "bash" }],
    ["/hooks/Stop", { session_id: "s1", agent: "pi", cwd: "/p" }],
  ]);
});
