import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { $, browser, expect } from "@wdio/globals";

import { startDaemon, stopDaemon } from "./fixture.ts";

describe("settings round trip", () => {
  let daemon: ChildProcess;
  before(async () => {
    daemon = await startDaemon();
    // The app polls settings once a minute; reload so it sees the daemon that just came up.
    await browser.refresh();
  });
  after(() => stopDaemon(daemon));

  it("saves root folders to the daemon config file", async () => {
    await $('nav[aria-label="Views"]').$("button=Settings").click();

    const roots = $("#roots");
    await browser.waitUntil(async () => (await roots.getValue()).includes("projects-a"), {
      timeoutMsg: "settings did not load the sandbox root",
    });
    const first = await roots.getValue();
    const second = first.replace("projects-a", "projects-b");

    await roots.setValue(`${first}\n${second}`);
    await $("button=Save").click();
    await expect($("[data-sonner-toast]")).toHaveText(expect.stringContaining("Saved."));

    const saved = readFileSync(join(process.env.DAS_CONFIG_DIR!, "config.yml"), "utf8");
    expect(saved).toContain(first);
    expect(saved).toContain(second);
  });
});
