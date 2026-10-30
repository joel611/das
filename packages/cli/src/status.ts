import { basename } from "node:path";
import type { Session, SessionState } from "./sessions";

const GROUPS: [SessionState, string][] = [
  ["running", "Running"],
  ["waiting", "Waiting"],
  ["error", "Error"],
  ["done", "Done"],
  ["idle", "Idle"],
];
/** Per group, so a spoken answer stays short. */
const MAX_NAMED = 4;

const label = (s: Session) => {
  const name = s.project ?? (basename(s.cwd) || "unknown");
  return s.branch && s.branch !== "main" && s.branch !== "master" ? `${name} on ${s.branch}` : name;
};

/** A short answer to "what's running?", one sentence per state, busiest first. */
export function statusText(sessions: Session[]): string {
  if (!sessions.length) return "Nothing is running.";
  const parts = GROUPS.flatMap(([state, title]) => {
    const group = sessions.filter((s) => s.state === state);
    if (!group.length) return [];
    const named = group.slice(0, MAX_NAMED).map(label);
    const more = group.length > MAX_NAMED ? ` and ${group.length - MAX_NAMED} more` : "";
    return [`${title}: ${named.join(", ")}${more}.`];
  });
  return `${sessions.length} session${sessions.length === 1 ? "" : "s"}. ${parts.join(" ")}`;
}
