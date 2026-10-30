import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_PROVIDER, CodexAuthFile, defaultCodexAuthFile } from "./codex-auth";
import { openaiSubscriptionModels } from "./orchestrator-start";

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const EXP = Math.floor(Date.now() / 1000) + 3600;

const codexFile = (data: unknown) => {
  const file = join(mkdtempSync(join(tmpdir(), "codex-auth-")), "auth.json");
  writeFileSync(file, JSON.stringify(data));
  return file;
};
const login = (access = jwt(EXP)) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  last_refresh: "2026-01-01T00:00:00.000Z",
  tokens: { access_token: access, refresh_token: "r1", id_token: "i1", account_id: "acc" },
});

test("default file follows CODEX_HOME", () => {
  expect(defaultCodexAuthFile({ CODEX_HOME: "/x/codex" })).toBe("/x/codex/auth.json");
  expect(defaultCodexAuthFile({}).endsWith("/.codex/auth.json")).toBe(true);
});

test("reads Codex tokens as an openai-codex OAuth credential", async () => {
  const store = new CodexAuthFile(codexFile(login()));
  expect(await store.read(CODEX_PROVIDER)).toEqual({
    type: "oauth",
    access: jwt(EXP),
    refresh: "r1",
    expires: EXP * 1000,
    accountId: "acc",
  });
  expect(await store.list()).toEqual([{ providerId: CODEX_PROVIDER, type: "oauth" }]);
  expect(await store.read("openai")).toBeUndefined();
});

test("an API-key login has no OAuth credential", async () => {
  const store = new CodexAuthFile(
    codexFile({ auth_mode: "apikey", OPENAI_API_KEY: "sk", tokens: null }),
  );
  expect(await store.read(CODEX_PROVIDER)).toBeUndefined();
  expect(await store.list()).toEqual([]);
});

test("a refresh is written back, 0600, keeping every other field", async () => {
  const file = codexFile(login());
  const store = new CodexAuthFile(file);
  await store.modify(CODEX_PROVIDER, async (c) => ({ ...(c as any), access: "a2", refresh: "r2" }));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.tokens).toEqual({
    access_token: "a2",
    refresh_token: "r2",
    id_token: "i1",
    account_id: "acc",
  });
  expect(saved.auth_mode).toBe("chatgpt");
  expect(saved.last_refresh).not.toBe("2026-01-01T00:00:00.000Z");
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("delete never signs Codex out", async () => {
  const file = codexFile(login());
  await new CodexAuthFile(file).delete();
  expect(JSON.parse(readFileSync(file, "utf8")).tokens.refresh_token).toBe("r1");
});

test("the orchestrator uses the ChatGPT login Codex saved", async () => {
  const m = await openaiSubscriptionModels({
    codexAuthFile: codexFile(login(jwt(EXP))),
    orchestratorModel: "",
  });
  expect(m).toMatchObject({ provider: CODEX_PROVIDER, modelId: "gpt-6-luna" });
  const model = m.models.getModel(CODEX_PROVIDER, "gpt-6-luna");
  expect(model).toBeDefined();
  expect(JSON.stringify(await m.models.getAuth(model!))).toContain(jwt(EXP));
});

test("a missing login says how to sign in", async () => {
  const empty = codexFile({ auth_mode: "apikey", OPENAI_API_KEY: "sk" });
  await expect(
    openaiSubscriptionModels({ codexAuthFile: empty, orchestratorModel: "" }),
  ).rejects.toThrow(/no ChatGPT login .*codex login/);
});
