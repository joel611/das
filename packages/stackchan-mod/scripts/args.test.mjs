import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MOD_NAME, parseArgs, serverUrlFromHost, xsaPath } from "./args.mjs";

test("--server-url X and --server-url=X, last one wins", () => {
  expect(parseArgs(["--server-url", "ws://a"]).url).toBe("ws://a");
  expect(parseArgs(["--server-url=ws://b"]).url).toBe("ws://b");
  expect(parseArgs(["--server-url", "ws://a", "--server-url=ws://b"]).url).toBe("ws://b");
  expect(parseArgs(["--server-url=ws://b", "--server-url", "ws://a"]).url).toBe("ws://a");
});

test("--install is stripped from passthrough args", () => {
  const r = parseArgs(["--server-url", "ws://a", "--install", "--port", "/dev/x", "--foo=1"]);
  expect(r.install).toBe(true);
  expect(r.rest).toEqual(["--port", "/dev/x", "--foo=1"]);
  expect(parseArgs(["--server-url", "ws://a"]).install).toBe(false);
});

test("missing url yields undefined", () => {
  expect(parseArgs(["--install"]).url).toBeUndefined();
});

test("build.mjs without a url exits non-zero with usage", () => {
  const script = `${dirname(fileURLToPath(import.meta.url))}/build.mjs`;
  const r = spawnSync("node", [script, "--install"], {
    encoding: "utf8",
    env: { ...process.env, DAEMON_HOST: "" },
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("usage: mod:build --server-url");
});

test("serverUrlFromHost builds the wss URL", () => {
  expect(serverUrlFromHost("h.ts.net")).toBe("wss://h.ts.net/v1/ws");
  expect(serverUrlFromHost("192.168.1.10:5777")).toBe("ws://192.168.1.10:5777/v1/ws");
  expect(serverUrlFromHost("localhost:5777")).toBe("ws://localhost:5777/v1/ws");
  expect(serverUrlFromHost("")).toBeUndefined();
  expect(serverUrlFromHost(undefined)).toBeUndefined();
});

test("copied archive path matches the fixed-name staging dir", () => {
  // Regression: the staging dir was a random temp name, so the .xsa lookup hit a stale file.
  const xsa = xsaPath("/fw");
  expect(basename(xsa, ".xsa")).toBe(MOD_NAME);
  expect(basename(dirname(xsa))).toBe(MOD_NAME);
});
