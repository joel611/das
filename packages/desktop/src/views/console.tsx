import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useDaemonState, useProjects, useSettings, useVoice } from "@/lib/queries";
import type { VoiceReply } from "@/lib/types";

type Turn = { you: string } | { reply: VoiceReply; ms: number; dry: boolean };

const newDevice = () => "console-" + Math.random().toString(36).slice(2, 8);

function Debug({ r }: { r: VoiceReply }) {
  const d = r.debug;
  if (!d) return null;
  return (
    <div className="mt-2 flex flex-col gap-1 rounded-md border border-dashed p-2 text-xs">
      {d.intent && (
        <div>
          intent: <b>{d.intent}</b> · confidence: <b>{d.intentConfidence?.toFixed(2)}</b>
        </div>
      )}
      <div>
        choice: <b>{d.choice ?? "none"}</b> · confidence: <b>{d.confidence.toFixed(2)}</b> · band:{" "}
        <b>{d.band}</b>
      </div>
      {Object.entries(d.probabilities).map(([name, p]) => (
        <div key={name} className="flex items-center gap-2">
          <span className="w-2/5 truncate">{name}</span>
          <Progress value={Math.round(p * 100)} className="flex-1" />
          <span className="w-9 text-right tabular-nums">{p.toFixed(2)}</span>
        </div>
      ))}
      <div className="text-muted-foreground">
        thresholds: act {d.thresholds.act}, ask {d.thresholds.ask} · wouldSpawn:{" "}
        {String(d.wouldSpawn)}
      </div>
      <div className="break-all text-muted-foreground">cwd: {d.cwd ?? "-"}</div>
      <div className="break-all text-muted-foreground">
        worktree: {d.worktree ?? "(project main)"}
        {d.name ? ` · new worktree name: ${d.name}` : ""}
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<
  VoiceReply["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  spawned: "default",
  "dry-run": "secondary",
  ask: "outline",
  escalate: "outline",
  error: "destructive",
  status: "secondary",
  reply: "secondary",
};

export function Console() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [dry, setDry] = useState(true);
  const [device, setDevice] = useState("console");
  const [pendingReal, setPendingReal] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const projects = useProjects();
  const settings = useSettings();
  const state = useDaemonState(5000);
  const voice = useVoice();
  const busy = voice.isPending;
  const logEnd = useRef<HTMLDivElement>(null);
  const confirmBox = useRef<HTMLDivElement>(null);

  useEffect(() => logEnd.current?.scrollIntoView({ block: "end" }), [turns]);
  // Never leave the real-send prompt off-screen.
  useEffect(() => {
    if (pendingReal) confirmBox.current?.scrollIntoView({ block: "nearest" });
  }, [pendingReal]);

  async function run(msg: string, isDry: boolean) {
    setTurns((t) => [...t, { you: msg }]);
    const t0 = performance.now();
    try {
      const reply = await voice.mutateAsync({ text: msg, device, dryRun: isDry });
      setTurns((t) => [...t, { reply, ms: Math.round(performance.now() - t0), dry: isDry }]);
    } catch (e) {
      const reply: VoiceReply = {
        status: "error",
        text: e instanceof Error ? e.message : String(e),
      };
      setTurns((t) => [...t, { reply, ms: Math.round(performance.now() - t0), dry: isDry }]);
    }
  }

  function send() {
    const msg = text.trim();
    if (!msg || busy) return;
    if (dry) {
      setText("");
      void run(msg, true);
    } else {
      // A real send needs a second, explicit click.
      setPendingReal(msg);
    }
  }

  function confirmReal() {
    const msg = pendingReal;
    setPendingReal(null);
    if (msg && !dry) {
      setText("");
      void run(msg, false);
    }
  }

  const shown = (projects.data ?? []).filter((p) =>
    (p.name + p.path).toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <Card>
          <CardContent>
            <ScrollArea className="h-80">
              <div className="flex flex-col gap-3 pr-3" aria-live="polite">
                {turns.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Type a request as if you said it to the robot. With Dry run on, nothing is
                    started.
                  </p>
                ) : null}
                {turns.map((t, i) =>
                  "you" in t ? (
                    <div
                      key={i}
                      className="self-end whitespace-pre-wrap rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground"
                    >
                      {t.you}
                    </div>
                  ) : (
                    <div key={i} className="text-sm">
                      <div className="flex items-center gap-2">
                        <Badge variant={STATUS_STYLE[t.reply.status]}>{t.reply.status}</Badge>
                        <span className="font-semibold">{t.reply.text}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[
                          t.reply.project && `project: ${t.reply.project}`,
                          t.reply.sessionId && `session: ${t.reply.sessionId}`,
                          `${t.ms} ms${t.dry ? " (dry run)" : ""}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                      <Debug r={t.reply} />
                    </div>
                  ),
                )}
                <div ref={logEnd} />
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type a request. Enter sends, Shift+Enter adds a line."
          rows={2}
          autoFocus
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={send} disabled={busy || !text.trim()}>
            Send
          </Button>
          <div className="flex items-center gap-2">
            <Checkbox
              id="dry"
              checked={dry}
              onCheckedChange={(v) => {
                setDry(v === true);
                setPendingReal(null);
              }}
            />
            <Label htmlFor="dry">Dry run</Label>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              setDevice(newDevice());
              setTurns([]);
              setPendingReal(null);
            }}
          >
            New conversation
          </Button>
          <span className="text-xs text-muted-foreground">device: {device}</span>
        </div>

        {!dry ? (
          <Alert variant="destructive">
            <AlertTitle>Real requests</AlertTitle>
            <AlertDescription>
              Sends start a Claude session in auto mode in an isolated worktree.
            </AlertDescription>
          </Alert>
        ) : null}
        {pendingReal ? (
          <Alert ref={confirmBox} variant="destructive" role="alertdialog">
            <AlertTitle>Send a REAL request?</AlertTitle>
            <AlertDescription>
              <q className="block whitespace-pre-wrap">{pendingReal}</q>
              <div className="mt-2 flex gap-2">
                <Button variant="destructive" onClick={confirmReal}>
                  Yes, send for real
                </Button>
                <Button variant="outline" onClick={() => setPendingReal(null)}>
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Routing</CardTitle>
          <CardDescription>
            {settings.data
              ? settings.data.hasOpenrouterKey
                ? "OpenRouter key: set"
                : "OpenRouter key: NOT set (requests will error)"
              : "…"}
            <br />
            {state.data
              ? state.data.untrustedProjects
                ? `${state.data.untrustedProjects} project(s) not trusted by Claude: real spawns there fail`
                : "All listed projects trusted"
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Input
            placeholder="Filter projects"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ScrollArea className="h-56">
            <ul className="flex flex-col divide-y pr-3">
              {shown.map((p) => (
                <li key={p.id} className="py-1.5">
                  <div className="text-sm">{p.name}</div>
                  <div className="break-all text-xs text-muted-foreground">{p.path}</div>
                </li>
              ))}
              {shown.length === 0 ? (
                <li className="py-1.5 text-xs text-muted-foreground">
                  {projects.data ? "no match" : "…"}
                </li>
              ) : null}
            </ul>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
