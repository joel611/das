import { $, $$, browser, expect } from "@wdio/globals";

describe("daemon offline", () => {
  it("shows the offline chip and an unreachable alert instead of crashing", async () => {
    await expect($('[role="status"]')).toHaveText(expect.stringContaining("daemon not running"), {
      wait: 10_000,
    });

    await $('nav[aria-label="Views"]').$("button=Settings").click();
    const alerts = $$('//*[@role="alert"][contains(., "Daemon not reachable")]');
    await browser.waitUntil(
      async () => (await alerts.filter((a) => a.isDisplayed())).length === 1,
      {
        timeout: 10_000,
        timeoutMsg: "no visible 'Daemon not reachable' alert",
      },
    );
    await expect(browser.$("h1")).toHaveText("DAS");
  });
});
