import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { LogEntry } from "@/lib/types";

const KEEP = 1000;
const SOURCES = ["all", "ws", "api"] as const;
type Source = (typeof SOURCES)[number];

/** Everything but the bookkeeping fields, as `key=value` pairs. */
function detail(e: LogEntry) {
  return Object.entries(e)
    .filter(([k]) => !["seq", "time", "source"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

export function Debug() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [source, setSource] = useState<Source>("all");
  const [text, setText] = useState("");
  // Cursor survives pause/clear: clear hides history, it never re-fetches it.
  const cursor = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  // Each poll fetches only entries after the cursor; the effect below appends them.
  const logs = useQuery({
    queryKey: ["logs"],
    queryFn: async () => {
      const fresh = await api.logs(cursor.current);
      if (fresh.length) cursor.current = fresh[fresh.length - 1].seq;
      return fresh;
    },
    refetchInterval: 1000,
    enabled: !paused,
    gcTime: 0,
  });
  const error = logs.error?.message;

  useEffect(() => {
    const fresh = logs.data;
    if (fresh?.length) setEntries((old) => [...old, ...fresh].slice(-KEEP));
  }, [logs.data]);

  const needle = text.trim().toLowerCase();
  const shown = entries.filter(
    (e) =>
      (source === "all" || e.source === source) &&
      (!needle || detail(e).toLowerCase().includes(needle)),
  );

  useEffect(() => {
    if (!paused) end.current?.scrollIntoView({ block: "end" });
  }, [shown.length, paused]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {SOURCES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={source === s ? "default" : "outline"}
            onClick={() => setSource(s)}
          >
            {s}
          </Button>
        ))}
        <Input
          className="max-w-xs"
          placeholder="filter text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEntries([])}>
          Clear
        </Button>
        {error ? <Badge variant="destructive">{error}</Badge> : null}
      </div>
      <Card>
        <CardContent>
          <div className="h-[60vh] overflow-auto font-mono text-xs" aria-live="off">
            {shown.length === 0 ? (
              <p className="text-muted-foreground">No entries.</p>
            ) : null}
            {shown.map((e) => (
              <div key={e.seq} className="whitespace-pre-wrap break-all">
                <span className="text-muted-foreground">{e.time.slice(11, 23)}</span>{" "}
                <span className="font-semibold">{e.source}</span> {detail(e)}
              </div>
            ))}
            <div ref={end} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
