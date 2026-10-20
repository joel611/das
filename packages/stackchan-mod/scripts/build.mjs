// Build the MOD with an overridden server URL.
// Without --server-url, the URL is $DAEMON_HOST/v1/ws (DAEMON_HOST includes ws:// or wss://), read from packages/stackchan-mod/.env (see .env.example).
// Usage: bun run mod:build -- --server-url ws://192.168.1.10:5777/v1/ws [--install [--port /dev/cu.usbmodemXXXX]]
// --install flashes the built MOD to the connected device (the host on it must be built with the same SDK).
// Uses the toolchain under <repo>/vendor (Moddable, ESP-IDF, stack-chan), installed on first run by scripts/toolchain.mjs.
// --install picks the only /dev/cu.usbmodem* port when --port is omitted.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureToolchain,
  firmware,
  pickPort,
  runInToolchain,
} from "../../../scripts/toolchain.mjs";
import { MOD_NAME, parseArgs, serverUrlFromHost, xsaPath } from "./args.mjs";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
// .env supplies DAEMON_HOST; variables already in the environment win.
if (existsSync(join(pkg, ".env"))) process.loadEnvFile(join(pkg, ".env"));
const parsed = parseArgs(args);
const { install, rest } = parsed;
let url = parsed.url;
if (!url) {
  try {
    url = serverUrlFromHost(process.env.DAEMON_HOST);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
if (!url) {
  console.error(
    "DAEMON_HOST is not set: copy .env.example to .env (in packages/stackchan-mod) and set it, or pass --server-url.\n" +
      "usage: mod:build --server-url <ws://host:port/v1/ws> [--install] [extra mod:build args]",
  );
  process.exit(1);
}

const src = readFileSync(join(pkg, "mod.js"), "utf8");
const re = /^const SERVER_URL = .*;$/m;
if (!re.test(src)) {
  console.error("SERVER_URL line not found in mod.js");
  process.exit(1);
}

// The archive is named after the manifest's directory, so keep that name fixed.
const tmp = join(mkdtempSync(join(tmpdir(), "stackchan-mod-")), MOD_NAME);
mkdirSync(tmp);
writeFileSync(
  join(tmp, "mod.js"),
  src.replace(re, () => `const SERVER_URL = ${JSON.stringify(url)};`),
);
copyFileSync(join(pkg, "manifest.json"), join(tmp, "manifest.json"));

ensureToolchain({ idf: install });

// Single connected device: pick its serial port unless --port was given.
if (install && !rest.some((a) => a === "--port" || a.startsWith("--port="))) {
  rest.push("--port", pickPort());
}

const run = runInToolchain(
  "npm",
  [
    "run",
    install ? "mod" : "mod:build",
    "--",
    join(tmp, "manifest.json"),
    "--mode=release",
    ...rest,
  ],
  { cwd: firmware },
);
if (run.error) {
  console.error(`cannot run mod:build in ${firmware}: ${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) process.exit(run.status ?? 1);

const xsa = xsaPath(firmware);
const out = join(pkg, "dist", "stackchan-mod.xsa");
mkdirSync(dirname(out), { recursive: true });
copyFileSync(xsa, out);
console.log(`built with SERVER_URL=${url} -> ${out}`);
