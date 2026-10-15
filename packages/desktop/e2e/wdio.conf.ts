import { resolve } from "node:path";

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
};
