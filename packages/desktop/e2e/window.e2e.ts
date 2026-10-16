import { browser, expect } from "@wdio/globals";

const visible = () =>
  browser.execute(() => window.__TAURI__.window.getCurrentWindow().isVisible()) as Promise<boolean>;

describe("window lifecycle", () => {
  it("hides on close and the app keeps running", async () => {
    await browser.execute(() => window.__TAURI__.window.getCurrentWindow().show());
    expect(await visible()).toBe(true);

    await browser.execute(() => window.__TAURI__.window.getCurrentWindow().close());
    await browser.waitUntil(async () => !(await visible()), {
      timeoutMsg: "window stayed visible",
    });

    expect(await browser.execute(() => document.title)).toBe("Stack-chan");
  });
});
