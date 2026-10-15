import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const KEEP = 1000;
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Line = { id: number; time: string; text: string };

/** Live USB serial log of the connected stack-chan (Tauri only). Stop it before flashing: the port is exclusive. */
export function DeviceConsole() {
  const [on, setOn] = useState(false);
  const [status, setStatus] = useState("stopped");
  const [lines, setLines] = useState<Line[]>([]);
  const id = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!inTauri) return;
    const subs = [
      listen<string>("device-log", (e) => {
        const line = { id: id.current++, time: new Date().toISOString().slice(11, 23), text: e.payload };
        setLines((old) => [...old, line].slice(-KEEP));
      }),
      listen<string>("device-status", (e) => setStatus(e.payload)),
    ];
    return () => {
      subs.forEach((s) => s.then((off) => off()));
    };
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  if (!inTauri) return <p className="text-muted-foreground">Device console needs the desktop app.</p>;

  const toggle = async () => {
    await invoke(on ? "serial_stop" : "serial_start");
    setOn(!on);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={on ? "default" : "outline"} onClick={toggle}>
          {on ? "Disconnect" : "Connect"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setLines([])}>
          Clear
        </Button>
        <Badge variant="outline">{status}</Badge>
      </div>
      <Card>
        <CardContent>
          <div className="h-[60vh] overflow-auto font-mono text-xs" aria-live="off">
            {lines.length === 0 ? <p className="text-muted-foreground">No lines.</p> : null}
            {lines.map((l) => (
              <div key={l.id} className="whitespace-pre-wrap break-all">
                <span className="text-muted-foreground">{l.time}</span> {l.text}
              </div>
            ))}
            <div ref={end} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
