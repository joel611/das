import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogs, type LogSink } from "../logs";
import { createServer } from "./server";

const sink = () => {
  const lines: Record<string, any>[] = [];
  const s: LogSink = { info: (o) => void lines.push(o) };
  return { s, lines };
};
const api = sink();
const ws = sink();
const server = createServer({
  port: 0,
  token: "secret",
  getProjects: () => [],
  logs: { api: api.s, ws: ws.s },
});
afterAll(() => server.stop(true));
const base = `localhost:${server.port}`;

const opened = (w: WebSocket) =>
  new Promise<void>((r, j) => ((w.onopen = () => r()), (w.onerror = () => j(new Error("ws")))));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(10);
};

test("api.log: method, path, status, ms for every request; no token, no query", async () => {
  await fetch(`http://${base}/health`);
  await fetch(`http://${base}/v1/sessions?token=secret`);
  await fetch(`http://${base}/v1/sessions`, { headers: { authorization: "Bearer secret" } });
  await fetch(`http://${base}/hooks/Stop`, { method: "POST", body: "{}" });
  await fetch(`http://${base}/nope`);
  expect(api.lines.map((l) => [l.method, l.path, l.status])).toEqual([
    ["GET", "/health", 200],
    ["GET", "/v1/sessions", 200],
    ["GET", "/v1/sessions", 200],
    ["POST", "/hooks/Stop", 204],
    ["GET", "/nope", 404],
  ]);
  expect(typeof api.lines[0].ms).toBe("number");
  expect(JSON.stringify(api.lines)).not.toContain("secret");
});

test("ws.log: upgrade, open, hello, frame types both ways, close; no payloads", async () => {
  await fetch(`http://${base}/v1/ws?token=nope`);
  const w = new WebSocket(`ws://${base}/v1/ws?token=secret`);
  await opened(w);
  w.send(JSON.stringify({ type: "hello", device: "kitchen-bot", capabilities: [] }));
  w.send(JSON.stringify({ type: "button", secretText: "do not log me" }));
  await until(() => ws.lines.some((l) => l.dir === "out" && l.type === "snapshot"));
  w.close();
  await until(() => ws.lines.some((l) => l.event === "close"));

  const ev = ws.lines.map((l) => l.event);
  expect(ev).toContain("open");
  expect(ws.lines).toContainEqual({ event: "upgrade", result: "rejected", status: 401 });
  expect(ws.lines).toContainEqual({ event: "upgrade", result: "accepted" });
  expect(ws.lines.find((l) => l.event === "hello")).toMatchObject({ device: "kitchen-bot" });
  const frames = ws.lines.filter((l) => l.event === "message").map((l) => [l.dir, l.type]);
  expect(frames).toContainEqual(["in", "hello"]);
  expect(frames).toContainEqual(["in", "button"]);
  expect(frames).toContainEqual(["out", "snapshot"]);
  expect(JSON.stringify(ws.lines)).not.toContain("do not log me");
  expect(JSON.stringify(ws.lines)).not.toContain("secret");
  expect(ws.lines.find((l) => l.event === "close")).toMatchObject({ device: "kitchen-bot" });
});

test("a throwing sink never breaks a request", async () => {
  const bad: LogSink = {
    info: () => {
      throw new Error("disk full");
    },
  };
  const s = createServer({
    port: 0,
    token: "",
    getProjects: () => [],
    logs: { api: bad, ws: bad },
  });
  const r = await fetch(`http://localhost:${s.port}/health`);
  expect(r.status).toBe(200);
  s.stop(true);
});

test("createLogs writes JSON lines to ws.log / api.log, redacting secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "das-logs-"));
  try {
    const logs = createLogs(dir);
    logs.api.info({
      method: "GET",
      path: "/x",
      status: 200,
      ms: 1,
      authorization: "Bearer s3cr3t",
    });
    logs.ws.info({ event: "open", conn: "c1" });
    const file = join(dir, "logs", "api.log");
    let text = "";
    for (let i = 0; i < 100 && !text.includes("\n"); i++) {
      await Bun.sleep(50);
      try {
        text = readFileSync(file, "utf8");
      } catch {}
    }
    const line = JSON.parse(text.split("\n")[0]);
    expect(line).toMatchObject({ method: "GET", path: "/x", status: 200 });
    expect(typeof line.time).toBe("string");
    expect(line.pid).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain("s3cr3t");
    expect(readlinkSync(file)).toContain("api");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/v1/logs: replays ws+api entries, honours ?after, hides secrets, skips its own polling", async () => {
  const h = { Authorization: "Bearer secret" };
  const all = await (await fetch(`http://${base}/v1/logs`, { headers: h })).json();
  expect(all.length).toBeGreaterThan(0);
  expect(new Set(all.map((e: any) => e.source))).toEqual(new Set(["ws", "api"]));
  expect(JSON.stringify(all)).not.toContain("secret");
  expect(all.some((e: any) => e.path === "/v1/logs")).toBe(false);
  const last = all[all.length - 1].seq;
  const none = await (await fetch(`http://${base}/v1/logs?after=${last}`, { headers: h })).json();
  expect(none).toEqual([]);
  expect((await fetch(`http://${base}/v1/logs`)).status).toBe(401);
});
