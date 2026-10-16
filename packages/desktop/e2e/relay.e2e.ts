import type { ChildProcess } from "node:child_process";

import { browser, expect } from "@wdio/globals";

import { startDaemon, stopDaemon } from "./fixture.ts";

const invokeApi = (method: string, path: string) =>
  browser.execute(
    (m, p) => window.__TAURI__.core.invoke("api", { method: m, path: p, body: null }),
    method,
    path,
  ) as Promise<{ status: number; body: Record<string, unknown> }>;

describe("api relay", () => {
  let daemon: ChildProcess;
  before(async () => {
    daemon = await startDaemon();
  });
  after(() => stopDaemon(daemon));

  it("adds the token so an authorized admin call succeeds", async () => {
    const direct = await fetch(`http://127.0.0.1:${process.env.PORT}/admin/settings`);
    expect(direct.status).toBe(401);

    const r = await invokeApi("GET", "/admin/settings");
    expect(r.status).toBe(200);
    expect(r.body.hasToken).toBe(true);
  });

  it("rejects paths outside /admin/ and /v1/", async () => {
    await expect(invokeApi("GET", "/etc/passwd")).rejects.toThrow("path not allowed");
  });
});
