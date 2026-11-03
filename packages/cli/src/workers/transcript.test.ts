import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript } from "./transcript";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const file = (lines: unknown[]) => {
  const d = mkdtempSync(join(tmpdir(), "das-tr-"));
  dirs.push(d);
  const p = join(d, "t.jsonl");
  writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  return p;
};
const asst = (...content: unknown[]) => ({ type: "assistant", message: { role: "assistant", content } });

test("reads last assistant text, latest todos and recent tools", () => {
  const p = file([
    asst({ type: "text", text: "first" }),
    asst({ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "a", status: "pending" }] } }),
    asst({ type: "tool_use", name: "Bash", input: { command: "ls" } }),
    "not json",
    asst({ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "a", status: "completed" }] } }),
    asst({ type: "text", text: "<das-done>ok</das-done>" }),
  ]);
  const s = readTranscript(p);
  expect(s.lastAssistant).toBe("<das-done>ok</das-done>");
  expect(s.todos).toEqual([{ content: "a", status: "completed" }]);
  expect(s.recentTools.map((t) => t.name)).toEqual(["TodoWrite", "Bash", "TodoWrite"]);
});

test("missing file is an empty snapshot", () => {
  expect(readTranscript("/nope/none.jsonl")).toEqual({
    lastAssistant: "",
    todos: [],
    recentTools: [],
  });
});
