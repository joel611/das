import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server";

const server = createServer({
  port: 0,
  token: "secret",
  getProjects: () => [],
  soundEnabled: () => true,
});
afterAll(() => server.stop(true));
const base = `localhost:${server.port}`;

const nextMessage = (ws: WebSocket) =>
  new Promise<any>((resolve) =>
    ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))), { once: true }),
  );
const opened = (ws: WebSocket) =>
  new Promise<void>(
    (r, j) => ((ws.onopen = () => r()), (ws.onerror = () => j(new Error("ws error")))),
  );

test("POST /v1/devices/:id/signal reaches only that device", async () => {
  const connect = async (device: string) => {
    const ws = new WebSocket(`ws://${base}/v1/ws?token=secret`);
    const frames: any[] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    await opened(ws);
    ws.send(JSON.stringify({ type: "hello", device, capabilities: ["screen"] }));
    return { ws, frames };
  };
  const a = await connect("sig-a");
  const b = await connect("sig-b");
  await Bun.sleep(100);
  const devices: { id: string; device: string }[] = await (
    await fetch(`http://${base}/v1/devices?token=secret`)
  ).json();
  const idA = devices.find((d) => d.device === "sig-a")!.id;
  const post = (id: string, body: unknown) =>
    fetch(`http://${base}/v1/devices/${id}/signal?token=secret`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  expect((await post(idA, { state: "error", sound: { hz: 440, ms: 100 } })).status).toBe(200);
  expect((await post(idA, { state: "bogus" })).status).toBe(400);
  expect((await post(idA, { sound: { hz: 1, ms: 100 } })).status).toBe(400);
  expect((await post("nope", { state: "done" })).status).toBe(404);
  await Bun.sleep(100);
  a.ws.close();
  b.ws.close();

  expect(b.frames.some((f) => f.type === "signal")).toBe(false);
  const signals = a.frames.filter((f) => f.type === "signal");
  expect(signals).toHaveLength(1);
  expect(signals[0].display.expression).toBe("sad");
  expect(signals[0].sound).toEqual({ hz: 440, ms: 100 });
});

test("rejects missing or wrong token", async () => {
  expect((await fetch(`http://${base}/v1/ws`)).status).toBe(401);
  expect((await fetch(`http://${base}/v1/ws?token=nope`)).status).toBe(401);
  await expect(opened(new WebSocket(`ws://${base}/v1/ws`))).rejects.toThrow();
});

test("hello -> snapshot, then hook -> delta, SessionEnd -> removal delta", async () => {
  const ws = new WebSocket(`ws://${base}/v1/ws?token=secret`);
  await opened(ws);
  const snap = nextMessage(ws);
  ws.send(JSON.stringify({ type: "hello", device: "test", capabilities: [] }));
  expect(await snap).toEqual({
    type: "snapshot",
    projects: [],
    sessions: [],
    display: {
      expression: "neutral",
      headline: "idle",
      count: 0,
      light: { mode: "blink", rgb: [255, 255, 255], periodMs: 1000 },
    },
  });

  ws.send("not json");
  ws.send(JSON.stringify({ type: "button" }));
  ws.send(JSON.stringify({ type: "whatever" }));

  const post = (event: string, body: object) =>
    fetch(`http://${base}/hooks/${event}`, { method: "POST", body: JSON.stringify(body) });

  let delta = nextMessage(ws);
  await post("UserPromptSubmit", { session_id: "s1", cwd: "/x" });
  const d = await delta;
  expect(d.type).toBe("delta");
  expect(d.session.id).toBe("s1");
  expect(d.display).toEqual({
    expression: "focused",
    headline: "1 running",
    count: 1,
    light: { mode: "rainbow" },
  });

  delta = nextMessage(ws);
  await post("SessionEnd", { session_id: "s1" });
  expect(await delta).toEqual({
    type: "delta",
    removed: "s1",
    display: {
      expression: "neutral",
      headline: "idle",
      count: 0,
      light: { mode: "blink", rgb: [255, 255, 255], periodMs: 1000 },
    },
  });
  ws.close();
});

test("a hook body that is not an object is ignored, not fatal", async () => {
  for (const body of ["null", "42", '"x"', "[]", "{"]) {
    const res = await fetch(`http://${base}/hooks/PreToolUse`, { method: "POST", body });
    expect(res.status).toBe(204);
  }
  await Bun.sleep(10); // the deferred transcript read must not throw either
  expect((await fetch(`http://${base}/v1/usage?token=secret`)).status).toBe(200);
});

test("entering done publishes a sound frame once", async () => {
  const ws = new WebSocket(`ws://${base}/v1/ws?token=secret`);
  await opened(ws);
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  const post = (event: string) =>
    fetch(`http://${base}/hooks/${event}`, {
      method: "POST",
      body: JSON.stringify({ session_id: "snd", cwd: "/x" }),
    });
  await post("UserPromptSubmit");
  await post("Stop");
  await post("Stop");
  await Bun.sleep(100);
  ws.close();
  expect(frames.filter((f) => f.type === "sound")).toEqual([{ type: "sound", hz: 880, ms: 150 }]);
});

test("no sound frame by default (notification sound off)", async () => {
  const quiet = createServer({
    port: 0,
    token: "secret",
    getProjects: () => [],
  });
  const ws = new WebSocket(`ws://localhost:${quiet.port}/v1/ws?token=secret`);
  await opened(ws);
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  const post = (event: string) =>
    fetch(`http://localhost:${quiet.port}/hooks/${event}`, {
      method: "POST",
      body: JSON.stringify({ session_id: "q", cwd: "/x" }),
    });
  await post("UserPromptSubmit");
  await post("Stop");
  await Bun.sleep(100);
  ws.close();
  quiet.stop(true);
  expect(frames.some((f) => f.type === "delta")).toBe(true);
  expect(frames.some((f) => f.type === "sound")).toBe(false);
});

test("health answers without a token", async () => {
  const res = await fetch(`http://${base}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("the status line relay endpoint is gone", async () => {
  const res = await fetch(`http://${base}/statusline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } }),
  });
  expect(res.status).toBe(404);
});
