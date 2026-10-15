import { $, browser, expect } from "@wdio/globals";

describe("dashboard", () => {
  it("renders the shell and switches views", async () => {
    await expect($("h1")).toHaveText("DAS");

    const nav = $('nav[aria-label="Views"]');
    await expect(nav).toBeDisplayed();

    await nav.$("button=Settings").click();
    await browser.saveScreenshot("./e2e/settings.png");
  });
});
