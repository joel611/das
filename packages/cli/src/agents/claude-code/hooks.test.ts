import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EVENTS, hooksStatus, installHooks, MARKER, uninstallHooks } from "./hooks";

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
const base = () => ({
  model: "opus",
  permissions: { allow: ["Bash(ls)"] },
  hooks: { Stop: [userHook], PostToolUse: [userHook] },
});

test("creates settings.json when missing, with every event", () => {
  const dir = fresh();
  const st = installHooks({ claudeDir: dir, port: 4321 });
  expect(st.state).toBe("installed");
  expect(Object.keys(load(dir).hooks).sort()).toEqual([...EVENTS].sort());
  const cmd = load(dir).hooks.Stop[0].hooks[0].command as string;
  expect(cmd).toContain("http://127.0.0.1:4321/hooks/Stop");
  expect(cmd).toContain(MARKER);
  expect(cmd).toContain(">/dev/null 2>&1 || true");
});

test("additive: keeps other keys and existing hooks, appends ours", () => {
  const dir = fresh(base());
  installHooks({ claudeDir: dir, port: 4321 });
  const s = load(dir);
  expect(s.model).toBe("opus");
  expect(s.permissions).toEqual(base().permissions);
  expect(s.hooks.PostToolUse).toEqual([userHook]);
  expect(s.hooks.Stop[0]).toEqual(userHook);
  expect(s.hooks.Stop).toHaveLength(2);
});

test("idempotent; reinstall with a new port updates in place without duplicates", () => {
  const dir = fresh(base());
  installHooks({ claudeDir: dir, port: 4321 });
  const once = readFileSync(join(dir, "settings.json"), "utf8");
  installHooks({ claudeDir: dir, port: 4321 });
  expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(once);
  const st = installHooks({ claudeDir: dir, port: 5000 });
  expect(st.portMatches).toBe(true);
  expect(st.port).toBe(5000);
  expect(load(dir).hooks.Stop).toHaveLength(2);
  expect(JSON.stringify(load(dir))).not.toContain("4321");
});

test("uninstall removes only ours and containers it emptied", () => {
  const dir = fresh(base());
  installHooks({ claudeDir: dir, port: 4321 });
  uninstallHooks({ claudeDir: dir });
  expect(load(dir)).toEqual(base());

  const empty = fresh({ model: "x" });
  installHooks({ claudeDir: empty, port: 4321 });
  uninstallHooks({ claudeDir: empty });
  expect(load(empty)).toEqual({ model: "x" });
});

test("uninstall leaves a user's pre-existing empty containers and an absent file alone", () => {
  const dir = fresh({ hooks: { Stop: [] } });
  uninstallHooks({ claudeDir: dir });
  expect(load(dir)).toEqual({ hooks: { Stop: [] } });
  const none = fresh();
  expect(uninstallHooks({ claudeDir: none }).state).toBe("missing");
  expect(existsSync(join(none, "settings.json"))).toBe(false);
});

test("status: missing / partial / installed, port mismatch", () => {
  const dir = fresh(base());
  expect(hooksStatus({ claudeDir: dir, port: 4321 }).state).toBe("missing");
  installHooks({ claudeDir: dir, port: 4321 });
  expect(hooksStatus({ claudeDir: dir, port: 4321 })).toMatchObject({
    state: "installed",
    portMatches: true,
  });
  const mismatch = hooksStatus({ claudeDir: dir, port: 9999 });
  expect(mismatch.portMatches).toBe(false);
  expect(mismatch.state).toBe("partial");
  const s = load(dir);
  delete s.hooks.Notification;
  writeFileSync(join(dir, "settings.json"), JSON.stringify(s));
  const st = hooksStatus({ claudeDir: dir, port: 4321 });
  expect(st.state).toBe("partial");
  expect(st.events.Notification).toBe("missing");
  expect(st.events.Stop).toBe("installed");
});

test("backup of the previous file is created before modifying; none when nothing changes", () => {
  const dir = fresh(base());
  const before = readFileSync(join(dir, "settings.json"), "utf8");
  installHooks({ claudeDir: dir, port: 4321 });
  const baks = readdirSync(dir).filter((f) => f.startsWith("settings.json.bak-"));
  expect(baks).toHaveLength(1);
  expect(readFileSync(join(dir, baks[0]), "utf8")).toBe(before);
  installHooks({ claudeDir: dir, port: 4321 });
  expect(readdirSync(dir).filter((f) => f.startsWith("settings.json.bak-"))).toHaveLength(1);
});

test("symlinked settings.json and symlinked dir are written through, never replaced", () => {
  const real = fresh(base());
  const link = mkdtempSync(join(root, "l-"));
  symlinkSync(join(real, "settings.json"), join(link, "settings.json"));
  installHooks({ claudeDir: link, port: 4321 });
  expect(lstatSync(join(link, "settings.json")).isSymbolicLink()).toBe(true);
  expect(load(real).hooks.Stop).toHaveLength(2);
  expect(readdirSync(link)).toEqual(["settings.json"]);

  const dirLink = join(root, "dirlink");
  symlinkSync(real, dirLink);
  uninstallHooks({ claudeDir: dirLink });
  expect(lstatSync(dirLink).isSymbolicLink()).toBe(true);
  expect(load(real)).toEqual(base());
});

test("atomic: no temp files left behind; invalid JSON is refused and untouched", () => {
  const dir = fresh(base());
  installHooks({ claudeDir: dir, port: 4321 });
  expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);

  const bad = fresh();
  writeFileSync(join(bad, "settings.json"), "{ not json");
  expect(() => installHooks({ claudeDir: bad, port: 4321 })).toThrow();
  expect(readFileSync(join(bad, "settings.json"), "utf8")).toBe("{ not json");
  expect(readdirSync(bad)).toEqual(["settings.json"]);
});
