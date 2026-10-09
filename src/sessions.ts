import { matchProject, type Project } from "./scanner";

export type SessionState = "idle" | "running" | "waiting" | "done" | "error";

export type Session = {
  id: string;
  project: string | null;
  worktree: string | null;
  branch: string | null;
  cwd: string;
  state: SessionState;
  detail: string | null;
  updatedAt: number;
};

type HookPayload = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  message?: string;
};

export class SessionTracker {
  private sessions = new Map<string, Session>();

  constructor(private getProjects: () => Project[]) {}

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Apply a Claude Code hook event. Returns the updated session, or null if ignored/removed. */
  handleHook(event: string, p: HookPayload): Session | null {
    if (!p.session_id) return null;
    if (event === "SessionEnd") {
      this.sessions.delete(p.session_id);
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
    this.sessions.set(next.id, next);
    return next;
  }
}
