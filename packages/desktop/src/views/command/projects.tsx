import { cn } from "@/lib/utils";
import type { Project, Session } from "@/lib/types";

import { Panel, PanelTitle, STATE_COLOR } from "./hud";

type WorktreeGroup = { path: string; branch: string | null; agents: Session[] };
type ProjectGroup = { name: string; worktrees: WorktreeGroup[] };

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Roots every worktree and agent under its project name; agents matching no project fall under "other". */
function groupByProject(projects: Project[], sessions: Session[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const p of projects) {
    const paths = p.worktrees.length ? p.worktrees : [{ path: p.path, branch: null }];
    groups.set(p.name, { name: p.name, worktrees: paths.map((w) => ({ ...w, agents: [] })) });
  }
  for (const s of sessions) {
    const owner = projects.find(
      (p) =>
        p.name === s.project || within(s.cwd, p.path) || p.worktrees.some((w) => within(s.cwd, w.path)),
    );
    const key = owner?.name ?? "other";
    let group = groups.get(key);
    if (!group) {
      group = { name: key, worktrees: [] };
      groups.set(key, group);
    }
    const path = s.worktree ?? s.cwd;
    let wt = group.worktrees.find((w) => within(s.cwd, w.path) || w.path === path);
    if (!wt) {
      wt = { path, branch: s.branch, agents: [] };
      group.worktrees.push(wt);
    }
    wt.agents.push(s);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, worktrees: g.worktrees.filter((w) => w.agents.length) }))
    .filter((g) => g.worktrees.length);
}

export function ProjectsPanel({
  projects,
  sessions,
  selected,
  onSelect,
}: {
  projects: Project[];
  sessions: Session[];
  selected: Session | undefined;
  onSelect: (id: string) => void;
}) {
  const active = sessions.filter((s) => s.state === "running" || s.state === "waiting");
  const groups = groupByProject(projects, active);
  return (
    <Panel className="flex flex-1 flex-col gap-3 px-4 pt-3.5 pb-4">
      <PanelTitle tone="magenta">PROJECTS</PanelTitle>
      {groups.length === 0 ? (
        <p className="m-0 font-mono text-xs text-hud-faint">No active agents.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {groups.map((g) => (
            <li key={g.name} className="flex flex-col gap-1.5">
              <span className="font-mono text-xs font-medium text-hud-ink">{g.name}</span>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 pl-3">
                {g.worktrees.map((w) => (
                  <li key={w.path} className="flex flex-col gap-0.5">
                    <span className="truncate font-mono text-[11px] text-hud-dim">
                      {w.path.split("/").pop()}
                    </span>
                    {w.agents.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={s.id === selected?.id}
                        onClick={() => onSelect(s.id)}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 border-0 bg-transparent py-0.5 pl-3 text-left font-mono text-[11px] text-hud-soft hover:bg-hud-hover",
                          s.id === selected?.id && "text-hud-ink",
                        )}
                      >
                        <span className={cn("size-1.5 shrink-0", STATE_COLOR[s.state].bg)} />
                        <span className="shrink-0 border border-hud-chip-dim px-1 text-[10px] text-hud-dim">
                          {s.agent === "omp" ? "omp" : "claude"}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{s.branch ?? w.branch ?? w.path.split("/").pop()}</span>
                        <span className={cn("uppercase", STATE_COLOR[s.state].text)}>{s.state}</span>
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
