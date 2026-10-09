import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "./scanner";
import { isTrusted, trustAdvice, trustedPaths } from "./trust";
import { handleTranscript, type VoiceDeps } from "./voice";

const proj = (path: string): Project => ({
  id: path,
  name: path.split("/").pop()!,
  path,
  worktrees: [{ path, branch: "main" }],
});

test("trust is inherited from any ancestor, never from siblings or prefixes", () => {
  const t = ["/h/Projects/personal"];
  expect(isTrusted("/h/Projects/personal", t, "/h")).toBe(true);
  expect(isTrusted("/h/Projects/personal/a/b/c", t, "/h")).toBe(true);
  expect(isTrusted("/h/Projects/other", t, "/h")).toBe(false);
  expect(isTrusted("/h/Projects/personal-evil", t, "/h")).toBe(false); // prefix, not ancestor
});

test("home directory trust is never counted", () => {
  expect(isTrusted("/h/Projects/a", ["/h"], "/h")).toBe(false);
});

test("reads only trusted entries from claude json, tolerates a missing file", () => {
  const f = join(mkdtempSync(join(tmpdir(), "trust-")), ".claude.json");
  writeFileSync(
    f,
    JSON.stringify({
      projects: {
        "/a": { hasTrustDialogAccepted: true },
        "/b": { hasTrustDialogAccepted: false },
        "/c": {},
      },
    }),
  );
  expect(trustedPaths(f)).toEqual(["/a"]);
  expect(trustedPaths(join(tmpdir(), "no-such-file.json"))).toEqual([]);
});

test("advice names untrusted roots and is null when everything is covered", () => {
  const projects = [proj("/h/Projects/personal/a"), proj("/h/Projects/work/b")];
  expect(trustAdvice(["/h/Projects"], projects, ["/h/Projects"])).toBeNull();
  const advice = trustAdvice(["/h/Projects"], projects, ["/h/Projects/personal"])!;
  expect(advice).toContain("1 of 2 projects");
  expect(advice).toContain("/h/Projects: 1 project(s) not trusted");
  expect(advice).toContain("accept the trust dialog");
});

test("a spawn refused for trust gets a specific reply", async () => {
  const deps: VoiceDeps = {
    decider: async () => ({ project: "a", confidence: 0.95, alternatives: [] }),
    spawner: async () => {
      throw new Error("claude exited 1: Workspace not trusted. Run `claude` in /x once");
    },
    getProjects: () => [proj("/x/a")],
    pending: new Map(),
  };
  const r = await handleTranscript(deps, "d", "do it");
  expect(r).toEqual({ status: "error", text: "Claude does not trust a yet" });
});
