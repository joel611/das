import type { AgentEvent, AgentSignal } from "../types";

/** The fields of a Claude Code hook payload (stdin JSON) the daemon uses. */
export type HookPayload = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { skill?: unknown };
  prompt?: string;
  message?: string;
  transcript_path?: string;
};

/** The skill a hook event shows being triggered: only the Skill tool counts, never a typed `/path`. */
export function skillOf(event: string, p: HookPayload): string | null {
  if (event === "PreToolUse" && p.tool_name === "Skill" && typeof p.tool_input?.skill === "string")
    return p.tool_input.skill.replace(/^\//, "") || null;
  return null;
}

function toEvent(event: string, p: HookPayload): AgentEvent | null {
  switch (event) {
    case "SessionStart":
      return { type: "start" };
    case "UserPromptSubmit":
      return { type: "prompt" };
    case "PreToolUse":
      return { type: "tool", tool: p.tool_name ?? "", skill: skillOf(event, p) ?? undefined };
    case "Notification":
      return { type: "waiting", message: p.message };
    case "Stop":
      return { type: "stop" };
    case "SessionEnd":
      return { type: "end" };
    default:
      return null;
  }
}

/** Claude Code hook event name + payload -> signal. A body that is not an object is not a hook payload. */
export function parseHook(event: string, body: unknown): AgentSignal | null {
  const p: HookPayload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (!p.session_id) return null;
  const e = toEvent(event, p);
  if (!e) return null;
  return { session: p.session_id, cwd: p.cwd, event: e, transcript: p.transcript_path };
}
