import { $, $$, browser, expect } from "@wdio/globals";

import { startMockApi } from "./fixture.ts";

const NAMES = ["alpha-app", "beta-service", "gamma-app"];
const project = (name: string) => ({
  id: `/mock/${name}`,
  name,
  path: `/mock/${name}`,
  worktrees: [],
});
const options = async () => [...(await $$('[role="option"]'))];
const optionTexts = async () => Promise.all((await options()).map((o) => o.getText()));

describe("jev project picker (mocked /v1/projects)", () => {
  let closeApi: () => Promise<void>;
  before(async () => {
    closeApi = await startMockApi({ "/v1/projects": NAMES.map(project) });
    // The app polls projects every 10s; reload so it sees the mock that just came up.
    await browser.refresh();
  });
  after(() => closeApi());

  const input = () => $('input[placeholder="auto"]');
  const openAll = async () => {
    await $('button[data-slot="input-group-button"]').click();
    await browser.waitUntil(async () => (await options()).length === NAMES.length, {
      timeoutMsg: "picker did not list every project",
    });
  };

  it("lists the projects from the api", async () => {
    await input().waitForDisplayed();
    await openAll();
    expect((await optionTexts()).sort()).toEqual(NAMES);
  });

  it("fuzzy filters and highlights the match", async () => {
    await input().setValue("app");
    await browser.waitUntil(async () => (await options()).length === 2, {
      timeoutMsg: "filter did not narrow the list",
    });
    expect((await optionTexts()).sort()).toEqual(["alpha-app", "gamma-app"]);
    expect((await $$('[role="option"] mark')).length).toBeGreaterThan(0);
  });

  it("shows every project again after selecting one", async () => {
    await $('[role="option"]=alpha-app').click();
    await expect(input()).toHaveValue("alpha-app");
    await openAll();
  });
});
