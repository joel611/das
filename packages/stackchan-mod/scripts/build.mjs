// Build the MOD with an overridden server URL.
// Usage: bun run build -- --server-url ws://192.168.1.10:5777/v1/ws
// Env: STACKCHAN_DIR (default ~/Developer/stack-chan), MODDABLE (required by the SDK tools).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const i = args.findIndex((a) => a === "--server-url" || a.startsWith("--server-url="));
if (i === -1) {
  console.error("usage: build --server-url <ws://host:port/v1/ws> [extra mod:build args]");
  process.exit(1);
}
const eq = args[i].startsWith("--server-url=");
const url = eq ? args[i].slice("--server-url=".length) : args[i + 1];
if (!url) {
  console.error("--server-url needs a value");
  process.exit(1);
}
const rest = args.filter((_, j) => j !== i && (eq || j !== i + 1));

const src = readFileSync(join(pkg, "mod.js"), "utf8");
const re = /^const SERVER_URL = .*;$/m;
if (!re.test(src)) {
  console.error("SERVER_URL line not found in mod.js");
  process.exit(1);
}

// The archive is named after the manifest's directory, so keep that name fixed.
const tmp = join(mkdtempSync(join(tmpdir(), "stackchan-mod-")), "stackchan-mod");
mkdirSync(tmp);
writeFileSync(join(tmp, "mod.js"), src.replace(re, () => `const SERVER_URL = ${JSON.stringify(url)};`));
copyFileSync(join(pkg, "manifest.json"), join(tmp, "manifest.json"));

const firmware = join(process.env.STACKCHAN_DIR ?? join(homedir(), "Developer/stack-chan"), "firmware");
const run = spawnSync(
  "npm",
  ["run", "mod:build", "--", join(tmp, "manifest.json"), "--mode=release", ...rest],
  { cwd: firmware, stdio: "inherit" },
);
if (run.error) {
  console.error(`cannot run mod:build in ${firmware}: ${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) process.exit(run.status ?? 1);

const xsa = join(firmware, "dist/bin/esp32/release/stackchan-mod/stackchan-mod.xsa");
const out = join(pkg, "dist", "stackchan-mod.xsa");
mkdirSync(dirname(out), { recursive: true });
copyFileSync(xsa, out);
console.log(`built with SERVER_URL=${url} -> ${out}`);
