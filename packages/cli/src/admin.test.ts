import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, readSettingsFile, writeSettingsFile } from "./config";
import { createServer } from "./api/server";
import type { Project } from "./scanner";

const TMP = "/Users/joel.chan/.claude/jobs/f23bdb0a/tmp";
mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(join(TMP, "admin-"));
const VARS = ["PROJECT_ROOTS", "PORT", "TOKEN", "OPENROUTER_API_KEY"];
const saved = VARS.map((k) => process.env[k]);
beforeAll(() => VARS.forEach((k) => delete process.env[k]));
afterAll(() => {
  VARS.forEach((k, i) =>
    saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]),
  );
  rmSync(root, { recursive: true, force: true });
});
const mk = (n: string) => {
  const d = join(root, n);
  mkdirSync(d, { recursive: true });
  return d;
};

test("settings file: 0600, merge, precedence env > file > defaults", () => {
  const dir = mk("cfg1");
  expect(loadConfig(dir, {})).toEqual({
    roots: [expect.stringMatching(/\/Projects$/)],
    port: 5777,
    token: "",
    openrouterKey: "",
  });
  writeSettingsFile({ roots: ["/a", "/b"], port: 5000, token: "t", openrouterKey: "k" }, dir);
  writeSettingsFile({ port: 5001 }, dir);
  expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
  expect(readSettingsFile(dir)).toEqual({
    roots: ["/a", "/b"],
    port: 5001,
    token: "t",
    openrouterKey: "k",
  });
  expect(loadConfig(dir, {})).toEqual({
    roots: ["/a", "/b"],
    port: 5001,
    token: "t",
    openrouterKey: "k",
  });
  expect(
    loadConfig(dir, { PROJECT_ROOTS: "/c", PORT: "6000", TOKEN: "e", OPENROUTER_API_KEY: "ek" }),
  ).toEqual({
    roots: ["/c"],
    port: 6000,
    token: "e",
    openrouterKey: "ek",
  });
  writeFileSync(join(dir, "config.json"), "garbage");
  expect(loadConfig(dir, {}).port).toBe(5777);
});

const setup = (token = "") => {
  const configDir = mk("cfg-" + Math.random().toString(36).slice(2));
  const claudeDir = mk("claude-" + Math.random().toString(36).slice(2));
  const projects: Project[] = [
    { id: "/p/a", name: "a", path: "/p/a", worktrees: [] },
    { id: "/p/b", name: "b", path: "/p/b", worktrees: [] },
  ];
  const changed: any[] = [];
  const server = createServer({
    port: 0,
    token,
    getProjects: () => projects,
    configDir,
    claudeDir,
    trusted: () => ["/p/a"],
    onSettings: (c) => changed.push(c),
  });
  return { server, configDir, claudeDir, changed, base: `http://127.0.0.1:${server.port}` };
};
const json = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("settings API: validation, secrets write-only, restartRequired, onSettings", async () => {
  const { server, configDir, changed, base } = setup();
  const good = mk("rootok");
  let r = await fetch(`${base}/admin/settings`);
  let j: any = await r.json();
  expect(j).toMatchObject({ port: 5777, hasToken: false, hasOpenrouterKey: false });
  expect(j.trustAdvice).toContain("1 of 2");

  for (const bad of [
    { roots: ["/nonexistent-xyz"] },
    { roots: "x" },
    { port: 0 },
    { port: 70000 },
    { port: 1.5 },
    { token: 5 },
  ]) {
    r = await fetch(`${base}/admin/settings`, json("PUT", bad));
    expect(r.status).toBe(400);
  }
  expect(readSettingsFile(configDir)).toEqual({});

  r = await fetch(
    `${base}/admin/settings`,
    json("PUT", { roots: [good], token: "tok-9x7", openrouterKey: "sk-secret" }),
  );
  j = await r.json();
  expect(j).toMatchObject({
    roots: [good],
    hasToken: true,
    hasOpenrouterKey: true,
    restartRequired: true,
  });
  expect(JSON.stringify(j)).not.toContain("sk-secret");
  expect(JSON.stringify(j)).not.toContain("tok-9x7");
  expect(changed).toHaveLength(1);
  expect(changed[0].roots).toEqual([good]);
  expect(statSync(join(configDir, "config.json")).mode & 0o777).toBe(0o600);

  // token is now live: unauthenticated request is refused, bearer works, secrets still hidden
  expect((await fetch(`${base}/admin/settings`)).status).toBe(401);
  const get = await fetch(`${base}/admin/settings`, {
    headers: { authorization: "Bearer tok-9x7" },
  });
  expect(JSON.stringify(await get.json())).not.toContain("sk-secret");

  // port equal to the running one needs no restart
  r = await fetch(
    `${base}/admin/settings`,
    json("PUT", { port: server.port }, { authorization: "Bearer tok-9x7" }),
  );
  expect(((await r.json()) as any).restartRequired).toBe(false);
  server.stop(true);
});

test("admin auth, 501 without dirs, hooks endpoints use the given claudeDir", async () => {
  const { server, claudeDir, base } = setup("s3");
  expect((await fetch(`${base}/admin/hooks`)).status).toBe(401);
  const auth = { authorization: "Bearer s3" };
  let j: any = await (await fetch(`${base}/admin/hooks`, { headers: auth })).json();
  expect(j.state).toBe("missing");
  j = await (await fetch(`${base}/admin/hooks/install`, json("POST", undefined, auth))).json();
  expect(j.state).toBe("installed");
  expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toContain("/hooks/SessionEnd");
  j = await (await fetch(`${base}/admin/hooks`, json("DELETE", undefined, auth))).json();
  expect(j.state).toBe("missing");
  expect((await fetch(`${base}/admin/nope`, { headers: auth })).status).toBe(404);
  server.stop(true);

  const bare = createServer({ port: 0, token: "", getProjects: () => [] });
  expect((await fetch(`http://127.0.0.1:${bare.port}/admin/hooks`)).status).toBe(501);
  expect((await fetch(`http://127.0.0.1:${bare.port}/admin/settings`)).status).toBe(501);
  bare.stop(true);
});

test("devices from hello, removed on close; /v1/state", async () => {
  const { server, base } = setup();
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/ws`);
  await new Promise((res) => (ws.onopen = res));
  ws.send(JSON.stringify({ type: "hello", device: "desk", capabilities: ["display", "mic"] }));
  await new Promise((res) => (ws.onmessage = res));
  const devs: any[] = await (await fetch(`${base}/v1/devices`)).json();
  expect(devs).toHaveLength(1);
  expect(devs[0]).toMatchObject({ device: "desk", capabilities: ["display", "mic"] });
  expect(typeof devs[0].id).toBe("string");
  expect(typeof devs[0].connectedAt).toBe("number");
  expect(await (await fetch(`${base}/v1/state`)).json()).toEqual({
    display: { expression: "neutral", headline: "idle", count: 0 },
    sessions: 0,
    devices: 1,
    projects: 2,
    untrustedProjects: 1,
  });
  ws.close();
  for (
    let i = 0;
    i < 50 && ((await (await fetch(`${base}/v1/devices`)).json()) as any[]).length;
    i++
  )
    await Bun.sleep(20);
  expect(await (await fetch(`${base}/v1/devices`)).json()).toEqual([]);
  server.stop(true);
});

test("/v1/state requires the token like other /v1 routes", async () => {
  const { server, base } = setup("zz");
  expect((await fetch(`${base}/v1/state`)).status).toBe(401);
  expect(
    (await fetch(`${base}/v1/state`, { headers: { authorization: "Bearer zz" } })).status,
  ).toBe(200);
  server.stop(true);
});
