import { useState } from "react";

import { useNow } from "@/hooks/use-now";
import { useProjects, useSessions, useUsage } from "@/lib/queries";

import { AgentsPanel } from "./agents";
import { URGENCY } from "./hud";
import { JevPanel } from "./jev";
import { ProjectsPanel } from "./projects";
import { UsagePanel } from "./usage";

/** The command center: agents and projects on the left, Jev in the middle, usage on the right. */
export function Command() {
  const sessions = useSessions();
  const projects = useProjects();
  const usage = useUsage();
  const now = useNow(5000);
  const [picked, setPicked] = useState<string>();

  const list = [...(sessions.data ?? [])].sort(
    (a, b) => URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state) || b.updatedAt - a.updatedAt,
  );
  const selected = list.find((s) => s.id === picked) ?? list[0];

  return (
    <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)_minmax(260px,320px)]">
      <section aria-labelledby="agents-h" className="flex min-w-0 flex-col gap-4">
        <AgentsPanel sessions={list} selected={selected} onSelect={setPicked} now={now} />
        <ProjectsPanel
          projects={projects.data ?? []}
          sessions={list}
          selected={selected}
          onSelect={setPicked}
        />
      </section>
      <JevPanel sessions={list} projects={projects.data ?? []} />
      <aside aria-labelledby="usage-h" className="flex min-w-0 flex-col gap-4">
        <UsagePanel usage={usage.data} sessions={list} now={now} />
      </aside>
    </div>
  );
}
