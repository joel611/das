import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server";

const server = createServer({ port: 0, token: "secret", getProjects: () => [] });
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

test("health answers without a token", async () => {
  const res = await fetch(`http://${base}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("status line relay: rate_limits show up in /v1/usage, the reply is the short line", async () => {
  const reset5h = Math.round(Date.now() / 1000) + 3600;
  const reset7d = reset5h + 86_400;
  const res = await fetch(`http://${base}/statusline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: "s1",
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: reset5h },
        seven_day: { used_percentage: 41.2, resets_at: reset7d },
      },
    }),
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toMatch(/^5h 24% \(\d+h\d+m\) · 7d 41% \(1d\dh\)$/);
  const u: any = await (await fetch(`http://${base}/v1/usage?token=secret`)).json();
  expect(u.limits.fiveHour).toMatchObject({ usedPercent: 23.5, resetsAt: reset5h * 1000 });
  expect(u.limits.sevenDay).toMatchObject({ usedPercent: 41.2, resetsAt: reset7d * 1000 });
  // a body without rate_limits, or not JSON, is fine
  const post = (init: RequestInit) =>
    fetch(`http://${base}/statusline`, { method: "POST", ...init });
  expect((await post({ headers: { "content-type": "application/json" }, body: "{" })).status).toBe(
    200,
  );
  // a web page can send text/plain (no preflight) or carries an Origin: neither may feed limits
  const forged = JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 100, resets_at: 99_999_999_999 } },
  });
  expect((await post({ body: forged })).status).toBe(403);
  expect((await post({ headers: { "content-type": "text/plain" }, body: forged })).status).toBe(
    403,
  );
  expect(
    (
      await post({
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: forged,
      })
    ).status,
  ).toBe(403);
});

test("status line relay ignores sessions of another Claude config dir", async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "claude-"));
  const srv = createServer({ port: 0, token: "secret", getProjects: () => [], claudeDir });
  try {
    const reset = Math.round(Date.now() / 1000) + 3600;
    const send = (dir?: string) =>
      fetch(`http://localhost:${srv.port}/statusline`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(dir ? { "x-claude-config-dir": dir } : {}),
        },
        body: JSON.stringify({
          rate_limits: { five_hour: { used_percentage: 77, resets_at: reset } },
        }),
      });
    const limits = async () =>
      ((await (await fetch(`http://localhost:${srv.port}/v1/usage?token=secret`)).json()) as any)
        .limits;
    expect((await send("/somewhere/else")).status).toBe(200);
    expect(await limits()).toBeNull();
    await send(claudeDir + "/");
    expect((await limits()).fiveHour.usedPercent).toBe(77);
  } finally {
    await srv.stop(true);
    rmSync(claudeDir, { recursive: true, force: true });
  }
});
