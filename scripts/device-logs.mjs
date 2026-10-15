// Streams the connected stack-chan's USB serial log (Moddable `trace()`) to stdout, one line per row.
//   bun run device:logs                      # follow until Ctrl-C
//   bun run device:logs -- --seconds 20      # exit after 20 s (for agents / scripts)
//   bun run device:logs -- --port /dev/cu.usbmodem1301
// Survives unplug and `device:restart`: the USB port disappears and returns on reset, so it waits for
// the port and reattaches, printing `[device:logs] ...` notices on stderr.
// The port is exclusive: stop this (and the desktop Serial tab) before `mod:install` / `device:deploy`.
import { spawnSync } from "node:child_process";
import { createReadStream, readdirSync } from "node:fs";
import { createInterface } from "node:readline";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const fixed = arg("--port");
const findPort = () =>
  fixed ??
  readdirSync("/dev")
    .filter((f) => f.startsWith("cu.usbmodem"))
    .sort()
    .map((f) => `/dev/${f}`)[0];

const seconds = Number(arg("--seconds"));
if (seconds > 0) setTimeout(() => process.exit(0), seconds * 1000);

const note = (msg) => console.error(`[device:logs] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);

/** Read one port until it closes or errors. Resolves with why. */
function attach(port) {
  return new Promise((resolve) => {
    // raw, no echo, and no hangup-on-close so closing the port does not toggle DTR (that resets the ESP32-S3).
    const stty = spawnSync("stty", ["-f", port, "115200", "raw", "-echo", "-hupcl"]);
    if (stty.status !== 0) return resolve(`stty failed: ${String(stty.stderr).trim()}`);

    const input = createReadStream(port);
    const rl = createInterface({ input });
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      rl.close();
      input.destroy();
      resolve(why);
    };
    rl.on("line", (line) => console.log(`${stamp()} ${line.replace(/\r$/, "")}`));
    input.on("error", (e) => finish(e.code ?? e.message));
    input.on("close", () => finish("closed"));
  });
}

let waiting = false;
for (;;) {
  const port = findPort();
  if (!port) {
    if (!waiting) note("waiting for /dev/cu.usbmodem* (plugged in?)");
    waiting = true;
    await sleep(300);
    continue;
  }
  waiting = false;
  note(`reading ${port} (Ctrl-C to stop)`);
  const why = await attach(port);
  note(`port ${port} lost (${why}); reattaching`);
  await sleep(300);
}
