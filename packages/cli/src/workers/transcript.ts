import { existsSync, readFileSync } from "node:fs";

export type Todo = { content: string; status: string };
export type ToolCall = { name: string; input: string };
export type TranscriptSnapshot = {
  lastAssistant: string;
  todos: Todo[];
  recentTools: ToolCall[];
};

const RECENT = 5;

/**
 * A passive read of a worker's session file (Claude's transcript JSONL; pi writes the same
 * message/content shape): the last assistant text, the latest TodoWrite state and the last few tool calls.
 * Unparseable lines and a missing file are skipped, so a half-written transcript still answers.
 */
export function readTranscript(path: string | undefined | null): TranscriptSnapshot {
  const snap: TranscriptSnapshot = { lastAssistant: "", todos: [], recentTools: [] };
  if (!path || !existsSync(path)) return snap;
  const tools: ToolCall[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const m = row?.message;
    if (row?.type !== "assistant" || !Array.isArray(m?.content)) continue;
    const text = m.content
      .flatMap((c: any) => (c?.type === "text" && typeof c.text === "string" ? [c.text] : []))
      .join("\n")
      .trim();
    if (text) snap.lastAssistant = text;
    for (const c of m.content) {
      if (c?.type !== "tool_use") continue;
      tools.push({ name: String(c.name), input: JSON.stringify(c.input ?? {}).slice(0, 200) });
      if (c.name === "TodoWrite" && Array.isArray(c.input?.todos))
        snap.todos = c.input.todos.map((t: any) => ({
          content: String(t.content ?? ""),
          status: String(t.status ?? ""),
        }));
    }
  }
  snap.recentTools = tools.slice(-RECENT);
  return snap;
}
