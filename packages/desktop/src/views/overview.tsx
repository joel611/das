import { useState } from "react";
import { toast } from "sonner";

import { StateBadge } from "@/components/state-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ago } from "@/lib/format";
import {
  useDaemonState,
  useDevices,
  useProjects,
  useSessions,
  useSignalDevice,
} from "@/lib/queries";
import type { Device, DeviceSignal, SessionState } from "@/lib/types";

const BEEP = { hz: 660, ms: 200 };
const ORDER: SessionState[] = ["error", "waiting", "running", "done", "idle"];

/** Click a device to open direct controls. Which ones show follows its declared capabilities. */
function DeviceRow({ d }: { d: Device }) {
  const [open, setOpen] = useState(false);
  const signal = useSignalDevice();
  const send = (s: DeviceSignal) =>
    signal.mutate({ id: d.id, signal: s }, { onError: (e) => toast.error(e.message) });
  return (
    <li className="py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full cursor-pointer text-left"
      >
        <div className="text-sm font-medium">{d.device}</div>
        <div className="text-xs text-muted-foreground">
          {d.capabilities.join(", ") || "no capabilities"} · connected {ago(d.connectedAt)}
        </div>
      </button>
      {open ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {d.capabilities.includes("screen")
            ? ORDER.map((s) => (
                <Button key={s} size="sm" variant="outline" onClick={() => send({ state: s })}>
                  {s}
                </Button>
              ))
            : null}
          {d.capabilities.includes("speaker") ? (
            <Button size="sm" variant="outline" onClick={() => send({ sound: BEEP })}>
              beep
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {hint ? <CardDescription>{hint}</CardDescription> : null}
      </CardHeader>
    </Card>
  );
}

export function Overview() {
  const state = useDaemonState();
  const sessions = useSessions();
  const projects = useProjects();
  const devices = useDevices();

  if (state.error && !state.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Daemon not reachable</AlertTitle>
        <AlertDescription>
          Start it with <code>bun run daemon --bg</code>, then this page updates by itself. (
          {state.error.message})
        </AlertDescription>
      </Alert>
    );
  }

  const s = state.data;
  const list = [...(sessions.data ?? [])].sort(
    (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.updatedAt - a.updatedAt,
  );
  const byProject = new Map<string, SessionState[]>();
  for (const x of list)
    if (x.project) byProject.set(x.project, [...(byProject.get(x.project) ?? []), x.state]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Status" value={s?.display.headline ?? "…"} hint={s?.display.expression} />
        <Stat label="Sessions" value={s?.sessions ?? "…"} />
        <Stat label="Devices" value={s?.devices ?? "…"} />
        <Stat
          label="Projects"
          value={s?.projects ?? "…"}
          hint={
            s?.untrustedProjects ? `${s.untrustedProjects} not trusted by Claude` : "all trusted"
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            Claude Code sessions reported by hooks, most urgent first
          </CardDescription>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sessions yet. Install the hooks in Settings, then start a Claude session.
            </p>
          ) : (
            <ScrollArea className="max-h-72">
              <ul className="flex flex-col divide-y">
                {list.map((x) => (
                  <li key={x.id} className="flex items-center gap-3 py-2">
                    <StateBadge state={x.state} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{x.project ?? x.cwd}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {[x.branch, x.detail].filter(Boolean).join(" · ") || x.cwd}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {ago(x.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Projects</CardTitle>
            <CardDescription>What voice requests can be routed to</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-64">
              <ul className="flex flex-col divide-y">
                {(projects.data ?? []).map((p) => (
                  <li key={p.id} className="py-2">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{p.name}</span>
                      {p.worktrees.length > 1 ? (
                        <Badge variant="outline">{p.worktrees.length} worktrees</Badge>
                      ) : null}
                      {(byProject.get(p.name) ?? []).slice(0, 4).map((st, i) => (
                        <StateBadge key={i} state={st} />
                      ))}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{p.path}</div>
                  </li>
                ))}
                {projects.data?.length === 0 ? (
                  <li className="py-2 text-sm text-muted-foreground">
                    No git projects under the roots. Set them in Settings.
                  </li>
                ) : null}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Devices</CardTitle>
            <CardDescription>Connected over WebSocket</CardDescription>
          </CardHeader>
          <CardContent>
            {(devices.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No device connected.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {(devices.data ?? []).map((d) => (
                  <DeviceRow key={d.id} d={d} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
