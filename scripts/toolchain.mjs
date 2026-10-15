// Device toolchain, kept entirely under <repo>/vendor (gitignored): Moddable SDK, ESP-IDF and its
// tools, and the stack-chan firmware's node_modules. Nothing is written to $HOME or a shell profile.
// `ensureToolchain()` is idempotent: each step is skipped once its stamp file exists, so it is
// cheap to call before every deploy. Used by scripts/device.mjs and packages/stackchan-mod.
//
// MODDABLE_REF must match the Moddable SDK that stack-chan's CI builds with
// (vendor/stack-chan/.github/actions/setup/action.yml) and ESP-IDF the one that SDK documents
// (documentation/devices/esp32.md). The host on the device and the MOD must use the same SDK.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MODDABLE_REF = "10.0.1";
export const IDF_REF = "v6.1";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const vendor = join(root, "vendor");
export const firmware = join(vendor, "stack-chan", "firmware");
export const moddable = join(vendor, "moddable");
export const idf = join(vendor, "esp-idf");
export const idfTools = join(vendor, "espressif");
export const fontbm = join(vendor, "fontbm");

const host = process.platform === "darwin" ? "mac" : "lin";
const stamps = join(vendor, ".stamps");

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error || r.status !== 0) {
    console.error(
      `toolchain: \`${[cmd, ...args].join(" ")}\` failed${r.error ? `: ${r.error.message}` : ""}`,
    );
    process.exit(r.status || 1);
  }
};

// Run `step` once; `name` is the stamp, so changing a pinned ref re-runs it.
const once = (name, step) => {
  const stamp = join(stamps, name);
  if (existsSync(stamp)) return;
  step();
  mkdirSync(stamps, { recursive: true });
  writeFileSync(stamp, "");
};

/** Env that points every tool at vendor/. Pass to child processes (after sourcing IDF export.sh). */
export function toolEnv(base = process.env) {
  const env = { ...base };
  // Drop another ESP-IDF's activated env, otherwise export.sh refuses to switch.
  for (const k of [
    "IDF_PYTHON_ENV_PATH",
    "ESP_IDF_VERSION",
    "OPENOCD_SCRIPTS",
    "ESP_ROM_ELF_DIR",
  ]) {
    delete env[k];
  }
  return {
    ...env,
    MODDABLE: moddable,
    IDF_PATH: idf,
    IDF_TOOLS_PATH: idfTools,
    FONTBM: join(fontbm, "build", "fontbm"),
    PATH: `${join(moddable, "build", "bin", host, "release")}:${env.PATH}`,
  };
}

/** Run a command with vendor/ tools and, when installed, the ESP-IDF environment (export.sh) active. */
export function runInToolchain(cmd, args, opts = {}) {
  return spawnSync(
    "bash",
    [
      "-c",
      '[ -f "$IDF_PATH/export.sh" ] && . "$IDF_PATH/export.sh" >/dev/null; exec "$@"',
      "toolchain",
      cmd,
      ...args,
    ],
    { stdio: "inherit", ...opts, env: toolEnv(opts.env) },
  );
}

/** Serial port of the one connected device, or exit asking for --port. */
export function pickPort() {
  const ports = readdirSync("/dev").filter((n) => n.startsWith("cu.usbmodem"));
  if (ports.length !== 1) {
    console.error(`pass --port: found ${ports.length} cu.usbmodem* ports`);
    process.exit(1);
  }
  return `/dev/${ports[0]}`;
}

/**
 * Make vendor/ ready: stack-chan checkout, Moddable SDK + tools, firmware node_modules and, unless
 * `{ idf: false }`, ESP-IDF and fontbm (needed to build/flash the host; ~3 GB, one time).
 */
export function ensureToolchain({ idf: withIdf = true } = {}) {
  if (!existsSync(join(vendor, "stack-chan", ".git"))) {
    run("node", [join(root, "scripts", "vendor-stack-chan.mjs")]);
  }
  if (!existsSync(firmware)) {
    console.error(
      `${firmware} not found: vendoring stack-chan failed (offline?), re-run \`bun install\``,
    );
    process.exit(1);
  }

  once(`moddable-${MODDABLE_REF}`, () => {
    console.log(`toolchain: Moddable ${MODDABLE_REF} -> ${moddable}`);
    if (!existsSync(moddable)) {
      run("git", [
        "clone",
        "--depth",
        "1",
        "-b",
        MODDABLE_REF,
        "https://github.com/Moddable-OpenSource/moddable.git",
        moddable,
      ]);
    }
    run("make", ["-C", join(moddable, "build", "makefiles", host)], { env: toolEnv() });
  });

  if (withIdf) {
    once(`esp-idf-${IDF_REF}`, () => {
      console.log(`toolchain: ESP-IDF ${IDF_REF} -> ${idf} (large download)`);
      if (!existsSync(idf)) {
        run("git", [
          "clone",
          "--depth",
          "1",
          "-b",
          IDF_REF,
          "--recursive",
          "--shallow-submodules",
          "https://github.com/espressif/esp-idf.git",
          idf,
        ]);
      }
      // esp32s3 = M5StackChan CoreS3; esp32 = Takao Core2.
      run(join(idf, "install.sh"), ["esp32s3,esp32"], { env: toolEnv() });
    });

    // Font converter the host build calls; stack-chan's CI builds it the same way (needs cmake, freetype).
    once("fontbm", () => {
      console.log(`toolchain: fontbm -> ${fontbm}`);
      if (!existsSync(fontbm)) {
        run("git", [
          "clone",
          "--depth",
          "1",
          "https://github.com/vladimirgamalyan/fontbm.git",
          fontbm,
        ]);
      }
      const build = join(fontbm, "build");
      mkdirSync(build, { recursive: true });
      run("cmake", ["..", "-DCMAKE_BUILD_TYPE=Release"], { cwd: build });
      run("make", ["-j4"], { cwd: build });
    });
  }

  // Reinstall when the (possibly pulled) lockfile is newer than the last install.
  const installed = join(firmware, "node_modules", ".package-lock.json");
  if (
    !existsSync(installed) ||
    statSync(join(firmware, "package-lock.json")).mtimeMs > statSync(installed).mtimeMs
  ) {
    console.log(`toolchain: npm ci in ${firmware}`);
    run("npm", ["ci"], { cwd: firmware });
  }
}
