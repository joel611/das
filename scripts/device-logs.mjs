// Streams the connected stack-chan's USB serial log (Moddable `trace()`) to stdout, one line per row.
//   bun run device:logs                      # follow until Ctrl-C
//   bun run device:logs -- --seconds 20      # exit after 20 s (for agents / scripts)
//   bun run device:logs -- --port /dev/cu.usbmodem1301
// The port is exclusive: stop this (and the desktop Serial tab) before `mod:install` / `device:deploy`.
import { spawnSync } from "node:child_process";
import { createReadStream, readdirSync } from "node:fs";
import { createInterface } from "node:readline";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const port =
  arg("--port") ??
  readdirSync("/dev")
    .filter((f) => f.startsWith("cu.usbmodem"))
    .sort()
    .map((f) => `/dev/${f}`)[0];
if (!port) {
  console.error("device:logs: no /dev/cu.usbmodem* port; is the stack-chan plugged in?");
  process.exit(1);
}

// raw, no echo, and no hangup-on-close so closing the port does not toggle DTR (that resets the ESP32-S3).
const stty = spawnSync("stty", ["-f", port, "115200", "raw", "-echo", "-hupcl"]);
if (stty.status !== 0) {
  console.error(`device:logs: stty failed on ${port}: ${stty.stderr}`);
  process.exit(1);
}

console.error(`device:logs: reading ${port} (Ctrl-C to stop)`);
const seconds = Number(arg("--seconds"));
if (seconds > 0) setTimeout(() => process.exit(0), seconds * 1000);

const rl = createInterface({ input: createReadStream(port) });
rl.on("line", (line) => console.log(`${new Date().toISOString().slice(11, 23)} ${line.replace(/\r$/, "")}`));
rl.on("close", () => {
  console.error("device:logs: port closed (unplugged?)");
  process.exit(1);
});
