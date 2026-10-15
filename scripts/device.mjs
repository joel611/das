// Flash the vendored stack-chan firmware (host) to the connected USB device.
// Usage: bun run device:setup                       # install the toolchain into vendor/ only
//        bun run device:deploy [-- --port /dev/cu.usbmodemXXXX]
//        bun run device:restart [-- --port ...]    # hard-reset the device, keeps firmware and MOD
// Replaces the host on the device; afterwards run `bun run mod:install` to put the MOD back.
// Picks the only /dev/cu.usbmodem* port when --port is omitted.
import { ensureToolchain, firmware, pickPort, runInToolchain } from "./toolchain.mjs";

const [cmd, ...args] = process.argv.slice(2);
if (cmd !== "setup" && cmd !== "deploy" && cmd !== "restart") {
  console.error("usage: device.mjs <setup|deploy|restart> [--port <serial port>]");
  process.exit(1);
}

// restart only needs esptool from an already-installed toolchain; do not trigger the ~3 GB install.
if (cmd !== "restart") ensureToolchain();
if (cmd === "setup") process.exit(0);

const i = args.findIndex((a) => a === "--port" || a.startsWith("--port="));
const port =
  i < 0 ? pickPort() : args[i].includes("=") ? args[i].slice("--port=".length) : args[i + 1];
if (!port) {
  console.error("--port needs a value");
  process.exit(1);
}

if (cmd === "restart") {
  // Hard-reset via esptool (the documented recovery); the port must be free, so stop device:logs first.
  const r = runInToolchain("esptool", [
    "--chip",
    "esp32s3",
    "--port",
    port,
    "--after",
    "hard-reset",
    "chip-id",
  ]);
  process.exit(r.status ?? 1);
}

const run = runInToolchain("npm", ["run", "flash"], {
  cwd: firmware,
  env: { ...process.env, STACKCHAN_PORT: port },
});
process.exit(run.status ?? 1);
