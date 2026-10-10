import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Claude,
  EVENTS,
  hasLegacyHooks,
  hooksStatus,
  installHooks,
  MARKER,
  PLUGIN,
  REPO_ROOT,
  removeLegacyHooks,
  uninstallHooks,
} from "./hooks-install";

const TMP = "/Users/joel.chan/.claude/jobs/f23bdb0a/tmp";
mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(join(TMP, "hooks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fresh = (settings?: object) => {
  const dir = mkdtempSync(join(root, "c-"));
  if (settings) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  return dir;
};
const load = (dir: string) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
const legacyHook = (ev: string) => ({
  hooks: [
    { type: "command", command: `curl ... http://127.0.0.1:4321/hooks/${ev} || true ${MARKER}` },
  ],
});
const legacy = () => ({
  model: "opus",
  hooks: {
    Stop: [userHook, legacyHook("Stop")],
    SessionEnd: [legacyHook("SessionEnd")],
    PostToolUse: [userHook],
  },
});

/** In-memory stand-in for the `claude plugin` CLI, recording every call. */
function fakeClaude() {
  const st = { marketplaces: new Map<string, string>(), installed: new Map<string, number>() };
  const calls: string[][] = [];
  const ok = (j: object) => ({ code: 0, stdout: JSON.stringify(j) + "\n", stderr: "" });
  const fail = (failureCode: string) => ({
    code: 1,
    stdout: JSON.stringify({ outcome: "failed", failureCode, message: failureCode }) + "\n",
    stderr: "",
  });
  const claude: Claude = async (args) => {
    calls.push(args);
    const a = args.filter((x) => x !== "--json");
    const cmd = a.slice(0, 3).join(" ");
    if (cmd.startsWith("plugin marketplace add")) {
      st.marketplaces.set("stack-chan", a[3]);
      return ok({ outcome: "ok" });
    }
    if (cmd.startsWith("plugin marketplace remove"))
      return st.marketplaces.delete(a[3]) ? ok({ outcome: "ok" }) : fail("not_configured");
    if (a[1] === "install") {
      if (!st.marketplaces.has("stack-chan")) return fail("not_found");
      st.installed.set(a[2], Number(a[a.indexOf("--config") + 1].split("=")[1]));
      return ok({ outcome: "ok" });
    }
    if (a[1] === "uninstall")
      return st.installed.delete(a[2]) ? ok({ outcome: "ok" }) : fail("not_installed");
    if (a[1] === "list")
      return {
        code: 0,
        stdout: JSON.stringify(
          [...st.installed.keys()].map((id) => ({ id, scope: "user", enabled: true })),
        ),
        stderr: "",
      };
    if (a[1] === "configure") {
      if (!st.installed.has(a[2])) return { code: 1, stdout: "No installed plugin", stderr: "" };
      return ok({
        inputs: { port: String(st.installed.get(a[2])) },
        schema: { port: { default: 4321 } },
      });
    }
    return { code: 2, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };
  return { claude, st, calls };
}

test("the plugin ships one forwarding hook per event", () => {
  const plugin = join(REPO_ROOT, "plugins", "stack-chan-hooks");
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")).hooks;
  expect(Object.keys(hooks).sort()).toEqual([...EVENTS].sort());
  for (const ev of EVENTS) expect(hooks[ev][0].hooks[0].command).toContain(`forward.sh ${ev}`);
  const market = JSON.parse(
    readFileSync(join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8"),
  );
  expect(`${market.plugins[0].name}@${market.name}`).toBe(PLUGIN);
  expect(existsSync(join(REPO_ROOT, market.plugins[0].source, "hooks", "forward.sh"))).toBe(true);
});

test("install adds the repo marketplace and installs the plugin with the port", async () => {
  const dir = fresh();
  const { claude, st, calls } = fakeClaude();
  const s = await installHooks({ claudeDir: dir, port: 4321, claude, repoRoot: "/repo" });
  expect(st.marketplaces.get("stack-chan")).toBe("/repo");
  expect(st.installed.get(PLUGIN)).toBe(4321);
  expect(calls.every((c) => c.includes("--json"))).toBe(true);
  expect(s).toEqual({
    state: "installed",
    installed: true,
    enabled: true,
    legacy: false,
    port: 4321,
    portMatches: true,
  });
  expect(existsSync(join(dir, "settings.json"))).toBe(false); // nothing written by us
});

test("reinstall with a new port reconfigures; status flags a stale port", async () => {
  const dir = fresh();
  const { claude, st } = fakeClaude();
  await installHooks({ claudeDir: dir, port: 4321, claude });
  expect((await hooksStatus({ claudeDir: dir, port: 5000, claude })).portMatches).toBe(false);
  await installHooks({ claudeDir: dir, port: 5000, claude });
  expect(st.installed.get(PLUGIN)).toBe(5000);
  expect((await hooksStatus({ claudeDir: dir, port: 5000, claude })).portMatches).toBe(true);
});

test("uninstall removes plugin and marketplace, and is idempotent", async () => {
  const dir = fresh();
  const { claude, st } = fakeClaude();
  await installHooks({ claudeDir: dir, port: 4321, claude });
  expect((await uninstallHooks({ claudeDir: dir, claude })).state).toBe("missing");
  expect(st.installed.size + st.marketplaces.size).toBe(0);
  expect((await uninstallHooks({ claudeDir: dir, claude })).state).toBe("missing");
});

test("a failing CLI call surfaces its message", async () => {
  const claude: Claude = async () => ({
    code: 1,
    stdout: '{"outcome":"failed","message":"marketplace file is invalid"}\n',
    stderr: "",
  });
  const err = await installHooks({ claudeDir: fresh(), port: 1, claude }).catch((e) => e);
  expect(String(err)).toContain("marketplace file is invalid");
});

test("legacy settings hooks: reported as partial, removed by install, other hooks kept, backup made", async () => {
  const dir = fresh(legacy());
  const { claude } = fakeClaude();
  expect(hasLegacyHooks(dir)).toBe(true);
  expect((await hooksStatus({ claudeDir: dir, port: 4321, claude })).state).toBe("partial");
  await installHooks({ claudeDir: dir, port: 4321, claude });
  const s = load(dir);
  expect(s.model).toBe("opus");
  expect(s.hooks).toEqual({ Stop: [userHook], PostToolUse: [userHook] });
  expect(readdirSync(dir).some((f) => f.startsWith("settings.json.bak-"))).toBe(true);
  expect((await hooksStatus({ claudeDir: dir, port: 4321, claude })).state).toBe("installed");
});

test("legacy cleanup: drops an emptied hooks key, leaves files without our hooks untouched", () => {
  const only = fresh({ hooks: { Stop: [legacyHook("Stop")] } });
  expect(removeLegacyHooks(only)).toBe(true);
  expect(load(only)).toEqual({});

  const mine = fresh({ hooks: { Stop: [userHook], Empty: [] } });
  const before = readFileSync(join(mine, "settings.json"), "utf8");
  expect(removeLegacyHooks(mine)).toBe(false);
  expect(readFileSync(join(mine, "settings.json"), "utf8")).toBe(before);
  expect(readdirSync(mine)).toEqual(["settings.json"]);

  expect(removeLegacyHooks(fresh())).toBe(false);
});

test("legacy cleanup writes through a symlinked settings.json", () => {
  const real = fresh(legacy());
  const dir = fresh();
  symlinkSync(join(real, "settings.json"), join(dir, "settings.json"));
  removeLegacyHooks(dir);
  expect(load(real).hooks.SessionEnd).toBeUndefined();
  expect(hasLegacyHooks(dir)).toBe(false);
});

test("refuses settings.json that is not a JSON object", () => {
  const bad = fresh();
  writeFileSync(join(bad, "settings.json"), "[1]");
  expect(() => removeLegacyHooks(bad)).toThrow();
});
