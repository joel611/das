import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { openaiSubscriptionModels } from "./orchestrator-start";
import { defaultPiAuthFile, PiAuthFile } from "./pi-auth";

const authFile = (data: unknown) => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-auth-")), "auth.json");
  writeFileSync(file, JSON.stringify(data));
  return file;
};
const oauth = (access: string) => ({
  type: "oauth",
  access,
  refresh: "r",
  expires: Date.now() + 3_600_000,
});

test("default file follows PI_CODING_AGENT_DIR", () => {
  expect(defaultPiAuthFile({ PI_CODING_AGENT_DIR: "/x/agent" })).toBe("/x/agent/auth.json");
  expect(defaultPiAuthFile({}).endsWith("/.pi/agent/auth.json")).toBe(true);
});

test("read, list, modify and delete keep other providers", async () => {
  const file = authFile({ anthropic: { type: "api_key", key: "k" }, openai: oauth("a1") });
  const store = new PiAuthFile(file);
  expect(await store.read("openai")).toMatchObject({ access: "a1" });
  expect(await store.list()).toEqual([
    { providerId: "anthropic", type: "api_key" },
    { providerId: "openai", type: "oauth" },
  ]);
  await store.modify("openai", async (c) => ({ ...(c as any), access: "a2" }));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.openai.access).toBe("a2");
  expect(saved.anthropic.key).toBe("k");
  await store.delete("anthropic");
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["openai"]);
});

test("a file das creates is 0600, like pi's", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-auth-")), "agent", "auth.json");
  await new PiAuthFile(file).modify("openai", async () => oauth("a") as any);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("modify waits for pi's lock on the same file", async () => {
  const file = authFile({ openai: oauth("a1") });
  const release = await lockfile.lock(file, { realpath: false });
  let done = false;
  const write = new PiAuthFile(file)
    .modify("openai", async (c) => ({ ...(c as any), access: "a2" }))
    .then(() => (done = true));
  await Bun.sleep(100);
  expect(done).toBe(false);
  await release();
  await write;
  expect(JSON.parse(readFileSync(file, "utf8")).openai.access).toBe("a2");
});

test("the orchestrator uses the ChatGPT login pi saved", async () => {
  const m = await openaiSubscriptionModels({
    piAuthFile: authFile({ openai: oauth("tok-1") }),
    orchestratorModel: "",
  });
  expect(m).toMatchObject({ provider: "openai", modelId: "gpt-6-luna" });
  const model = m.models.getModel("openai", "gpt-6-luna");
  expect(model).toBeDefined();
  expect(JSON.stringify(await m.models.getAuth(model!))).toContain("tok-1");
});

test("a legacy openai-codex login works too, and a missing login says how to sign in", async () => {
  const m = await openaiSubscriptionModels({
    piAuthFile: authFile({ "openai-codex": oauth("tok-2") }),
    orchestratorModel: "gpt-6-sol",
  });
  expect(m).toMatchObject({ provider: "openai-codex", modelId: "gpt-6-sol" });

  const empty = authFile({ openai: { type: "api_key", key: "sk" } });
  await expect(
    openaiSubscriptionModels({ piAuthFile: empty, orchestratorModel: "" }),
  ).rejects.toThrow(/no OpenAI subscription login .*\/login/);
});
