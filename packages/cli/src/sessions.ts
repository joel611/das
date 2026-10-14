import { matchProject, type Project } from "./scanner";

export type SessionState = "idle" | "running" | "waiting" | "done" | "error";

/** A skill this session ran, counted from Skill tool calls. */
export type SkillUse = { name: string; count: number; lastAt: number };

export type Session = {
  id: string;
  project: string | null;
  worktree: string | null;
  branch: string | null;
  cwd: string;
  state: SessionState;
  detail: string | null;
  skills: SkillUse[];
  updatedAt: number;
};

export type ChangeEvent = { session: Session } | { removed: string };

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

function countSkill(skills: SkillUse[], name: string, at: number): SkillUse[] {
  const prev = skills.find((k) => k.name === name);
  const next = { name, count: (prev?.count ?? 0) + 1, lastAt: at };
  return [next, ...skills.filter((k) => k !== prev)];
}

export class SessionTracker {
  private sessions = new Map<string, Session>();

  private listeners: ((e: ChangeEvent) => void)[] = [];

  constructor(private getProjects: () => Project[]) {}

  /** Subscribe to session changes (updates and removals). */
  onChange(fn: (e: ChangeEvent) => void) {
    this.listeners.push(fn);
  }

  private emit(e: ChangeEvent) {
    for (const fn of this.listeners) fn(e);
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Apply a Claude Code hook event. Returns the updated session, or null if ignored/removed. */
  handleHook(event: string, p: HookPayload): Session | null {
    if (!p.session_id) return null;
    if (event === "SessionEnd") {
      if (this.sessions.delete(p.session_id)) this.emit({ removed: p.session_id });
      return null;
    }
    const prev = this.sessions.get(p.session_id);
    const cwd = p.cwd ?? prev?.cwd ?? "";
    const match = matchProject(this.getProjects(), cwd);
    const next: Session = {
      id: p.session_id,
      project: match?.project.name ?? prev?.project ?? null,
      worktree: match?.worktree.path ?? prev?.worktree ?? null,
      branch: match?.worktree.branch ?? prev?.branch ?? null,
      cwd,
      state: prev?.state ?? "idle",
      detail: prev?.detail ?? null,
      skills: prev?.skills ?? [],
      updatedAt: Date.now(),
    };
    switch (event) {
      case "SessionStart":
        next.state = "idle";
        next.detail = null;
        break;
      case "UserPromptSubmit":
        next.state = "running";
        next.detail = null;
        break;
      case "PreToolUse":
        next.state = "running";
        next.detail = p.tool_name ?? null;
        break;
      case "Notification":
        next.state = "waiting";
        next.detail = p.message ?? null;
        break;
      case "Stop":
        next.state = "done";
        next.detail = null;
        break;
      default:
        return null;
    }
    const skill = skillOf(event, p);
    if (skill) {
      next.skills = countSkill(next.skills, skill, next.updatedAt);
      if (event === "PreToolUse") next.detail = `/${skill}`;
    }
    this.sessions.set(next.id, next);
    this.emit({ session: next });
    return next;
  }
}
