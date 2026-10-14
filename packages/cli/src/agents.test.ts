import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode } from "./agents/claude-code";
import { parseHook } from "./agents/claude-code/events";
import type { AgentProvider } from "./agents/types";
import { createServer } from "./server";

const dir = mkdtempSync(join(tmpdir(), "agents-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A minimal second agent: posts `{ id, state }` and needs nothing else from the core. */
const fake: AgentProvider = {
  id: "fake",
  name: "Fake Agent",
  parseEvent: (event, body: any) =>
    typeof body?.id === "string" && event === "turn"
      ? { session: body.id, cwd: body.cwd, event: { type: body.state } }
      : null,
};

const server = createServer({
  port: 0,
  token: "",
  getProjects: () => [],
  agents: [claudeCode(), fake],
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
const post = (path: string, body: object) =>
  fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

test("claude code hooks map onto agent events", () => {
  expect(parseHook("Stop", {})).toBeNull(); // no session id
  expect(parseHook("PostToolUse", { session_id: "s" })).toBeNull(); // not an event we track
  expect(
    parseHook("PreToolUse", {
      session_id: "s",
      cwd: "/x",
      tool_name: "Skill",
      tool_input: { skill: "/dataviz" },
      transcript_path: "/t.jsonl",
    }),
  ).toEqual({
    session: "s",
    cwd: "/x",
    event: { type: "tool", tool: "Skill", skill: "dataviz" },
    transcript: "/t.jsonl",
  });
  expect(parseHook("Notification", { session_id: "s", message: "ok?" })?.event).toEqual({
    type: "waiting",
    message: "ok?",
  });
});

test("events route to their agent; the legacy path goes to the default agent", async () => {
  expect((await post("/hooks/fake/turn", { id: "f1", cwd: "/y", state: "prompt" })).status).toBe(
    204,
  );
  expect((await post("/hooks/UserPromptSubmit", { session_id: "c1", cwd: "/x" })).status).toBe(204);
  expect((await post("/hooks/claude-code/Stop", { session_id: "c1" })).status).toBe(204);
  expect((await post("/hooks/nope/turn", { id: "x" })).status).toBe(404);
  const sessions: any[] = await (await fetch(`${base}/v1/sessions`)).json();
  expect(
    sessions.map((s) => [s.id, s.agent, s.state]).sort((a, b) => a[0].localeCompare(b[0])),
  ).toEqual([
    ["c1", "claude-code", "done"],
    ["f1", "fake", "running"],
  ]);
});

test("/v1/agents lists capabilities; integrations answer per agent", async () => {
  expect(await (await fetch(`${base}/v1/agents`)).json()).toEqual([
    // no claudeDir: transcripts that hooks point at are read, but nothing is installed
    {
      id: "claude-code",
      name: "Claude Code",
      usage: true,
      integration: false,
      spawn: true,
      trust: true,
    },
    {
      id: "fake",
      name: "Fake Agent",
      usage: false,
      integration: false,
      spawn: false,
      trust: false,
    },
  ]);
  expect((await fetch(`${base}/admin/agents/fake/integration`)).status).toBe(501);
  expect((await fetch(`${base}/admin/agents/nope/integration`)).status).toBe(404);
  expect((await fetch(`${base}/admin/hooks`)).status).toBe(501);
});

test("an agent's integration is reachable under its own id", async () => {
  const claudeDir = join(dir, "claude");
  const s = createServer({ port: 0, token: "", getProjects: () => [], claudeDir });
  const url = `http://127.0.0.1:${s.port}/admin/agents/claude-code/integration`;
  expect((await (await fetch(url)).json()).state).toBe("missing");
  expect((await (await fetch(`${url}/install`, { method: "POST" })).json()).state).toBe(
    "installed",
  );
  expect((await (await fetch(`http://127.0.0.1:${s.port}/admin/hooks`)).json()).state).toBe(
    "installed",
  );
  expect((await (await fetch(url, { method: "DELETE" })).json()).state).toBe("missing");
  void s.stop(true);
});
