import type { AgentSignal } from "./agents/types";
import { matchProject, type Project } from "./scanner";

export type SessionState = "idle" | "running" | "waiting" | "done" | "error";

/** A skill this session ran, counted from Skill tool calls. */
export type SkillUse = { name: string; count: number; lastAt: number };

export type Session = {
  id: string;
  /** Provider id of the agent running this session, e.g. "claude-code". */
  agent: string;
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

  /** Apply an agent's signal. Returns the updated session, or null if removed. */
  handle(agent: string, { session: id, cwd: dir, event: e }: AgentSignal): Session | null {
    if (e.type === "end") {
      if (this.sessions.delete(id)) this.emit({ removed: id });
      return null;
    }
    const prev = this.sessions.get(id);
    const cwd = dir ?? prev?.cwd ?? "";
    const match = matchProject(this.getProjects(), cwd);
    const next: Session = {
      id,
      agent,
      project: match?.project.name ?? prev?.project ?? null,
      worktree: match?.worktree.path ?? prev?.worktree ?? null,
      branch: match?.worktree.branch ?? prev?.branch ?? null,
      cwd,
      state: prev?.state ?? "idle",
      detail: prev?.detail ?? null,
      skills: prev?.skills ?? [],
      updatedAt: Date.now(),
    };
    switch (e.type) {
      case "start":
        next.state = "idle";
        next.detail = null;
        break;
      case "prompt":
        next.state = "running";
        next.detail = null;
        break;
      case "tool":
        next.state = "running";
        next.detail = e.tool || null;
        if (e.skill) {
          next.skills = countSkill(next.skills, e.skill, next.updatedAt);
          next.detail = `/${e.skill}`;
        }
        break;
      case "waiting":
        next.state = "waiting";
        next.detail = e.message ?? null;
        break;
      case "stop":
        next.state = "done";
        next.detail = null;
        break;
    }
    this.sessions.set(next.id, next);
    this.emit({ session: next });
    return next;
  }
}
