import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, test } from "vite-plus/test";

import { Command } from ".";

const NAMES = ["alpha-app", "beta-service", "gamma-app"];

/** Stand-in for the Rust `api` relay: canned bodies per path, 404 for everything else. */
function mockApi(routes: Record<string, unknown>) {
  mockIPC((cmd, args) => {
    if (cmd !== "api") return;
    const { path } = args as { path: string };
    return path in routes
      ? { status: 200, body: routes[path] }
      : { status: 404, body: { error: "not mocked" } };
  });
}

function renderCommand() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Command />
    </QueryClientProvider>,
  );
}

const project = (name: string) => ({
  id: `/mock/${name}`,
  name,
  path: `/mock/${name}`,
  worktrees: [],
});
const optionTexts = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("jev project picker", () => {
  beforeEach(() => {
    mockApi({ "/v1/projects": NAMES.map(project), "/v1/sessions": [] });
  });

  async function openPicker() {
    const user = userEvent.setup();
    renderCommand();
    const input = await screen.findByPlaceholderText("auto");
    // Projects arrive asynchronously; opening the list before then shows "No project".
    await user.click(input);
    await screen.findAllByRole("option");
    return { user, input };
  }

  test("lists the projects returned by the api", async () => {
    await openPicker();
    expect(optionTexts().sort()).toEqual(NAMES);
  });

  test("fuzzy filters and highlights the matched letters", async () => {
    const { user, input } = await openPicker();
    await user.type(input, "app");

    expect(optionTexts().sort()).toEqual(["alpha-app", "gamma-app"]);
    const marks = within(screen.getByRole("option", { name: "alpha-app" })).getAllByText(/./, {
      selector: "mark",
    });
    expect(marks.map((m) => m.textContent).join("")).toBe("app");
  });

  // Base UI emits onInputValueChange("alpha-app", "item-press") on select; jev.tsx must not keep that as the filter.
  // jsdom doesn't reproduce a collapsed list without that guard, so this checks behavior, not the guard itself.
  test("lists every project again after selecting one", async () => {
    const { user, input } = await openPicker();
    await user.type(input, "app");
    await user.click(screen.getByRole("option", { name: "alpha-app" }));
    expect((input as HTMLInputElement).value).toBe("alpha-app");

    await user.click(input);
    expect(optionTexts().sort()).toEqual(NAMES);
  });
});
