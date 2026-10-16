import { resolve } from "node:path";

import { createSandbox } from "./fixture.ts";

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./*.e2e.ts"],
  maxInstances: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { timeout: 60_000 },
  services: [
    [
      "tauri",
      {
        appBinaryPath: resolve(import.meta.dirname, "../src-tauri/target/debug/stack-chan-app"),
        driverProvider: "embedded",
      },
    ],
  ],
  capabilities: [{ browserName: "tauri" }],
  // Workers and the app binary inherit this env, so nothing touches the real ~/.config/das or ~/.claude.
  onPrepare: async () => {
    await createSandbox();
  },
};
