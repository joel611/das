// Flash the vendored stack-chan firmware (host) to the connected USB device.
// Usage: bun run device:setup                       # install the toolchain into vendor/ only
//        bun run device:deploy [-- --port /dev/cu.usbmodemXXXX]
// Replaces the host on the device; afterwards run `bun run mod:install` to put the MOD back.
// Picks the only /dev/cu.usbmodem* port when --port is omitted.
import { ensureToolchain, firmware, pickPort, runInToolchain } from "./toolchain.mjs";

const [cmd, ...args] = process.argv.slice(2);
if (cmd !== "setup" && cmd !== "deploy") {
  console.error("usage: device.mjs <setup|deploy> [--port <serial port>]");
  process.exit(1);
}

ensureToolchain();
if (cmd === "setup") process.exit(0);

const i = args.findIndex((a) => a === "--port" || a.startsWith("--port="));
const port =
  i < 0 ? pickPort() : args[i].includes("=") ? args[i].slice("--port=".length) : args[i + 1];
if (!port) {
  console.error("--port needs a value");
  process.exit(1);
}

const run = runInToolchain("npm", ["run", "flash"], {
  cwd: firmware,
  env: { ...process.env, STACKCHAN_PORT: port },
});
process.exit(run.status ?? 1);
