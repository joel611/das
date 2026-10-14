import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useHookAction, useHooks, useSaveSettings, useSettings } from "@/lib/queries";
import type { SettingsPatch } from "@/lib/types";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A write-only secret: the daemon never returns it, so the field only says whether one is set. */
function Secret(props: {
  id: string;
  label: string;
  isSet: boolean;
  value: string;
  clear: boolean;
  onValue: (v: string) => void;
  onClear: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <div className="flex items-center gap-3">
        <Input
          id={props.id}
          type="password"
          autoComplete="off"
          placeholder={props.isSet ? "(set) type to replace" : "(none)"}
          value={props.value}
          onChange={(e) => props.onValue(e.target.value)}
        />
        {props.isSet ? (
          <div className="flex shrink-0 items-center gap-2">
            <Checkbox
              id={`${props.id}-clear`}
              checked={props.clear}
              onCheckedChange={(v) => props.onClear(v === true)}
            />
            <Label htmlFor={`${props.id}-clear`}>Clear</Label>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Settings() {
  const settings = useSettings(60_000);
  const hooks = useHooks();
  const saveSettings = useSaveSettings();
  const hookAction = useHookAction();

  const [roots, setRoots] = useState("");
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const saving = saveSettings.isPending;

  const s = settings.data;
  useEffect(() => {
    if (s && !loaded) {
      setRoots(s.roots.join("\n"));
      setPort(String(s.port));
      setLoaded(true);
    }
  }, [s, loaded]);

  async function save() {
    const patch: SettingsPatch = {
      roots: roots
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean),
      port: Number(port),
    };
    if (clearToken) patch.token = "";
    else if (token) patch.token = token;
    if (clearKey) patch.openrouterKey = "";
    else if (key) patch.openrouterKey = key;
    try {
      const r = await saveSettings.mutateAsync(patch);
      setToken("");
      setKey("");
      setClearToken(false);
      setClearKey(false);
      toast.success(
        r.restartRequired
          ? "Saved. Restart the daemon for the new port: bun run daemon --stop && bun run daemon --bg"
          : "Saved.",
      );
    } catch (e) {
      toast.error(msg(e));
    }
  }

  async function runHookAction(kind: "install" | "uninstall") {
    try {
      await hookAction.mutateAsync(kind);
      toast.success(
        kind === "install"
          ? "Hooks installed. Restart running Claude sessions to load them."
          : "Hooks removed.",
      );
    } catch (e) {
      toast.error(msg(e));
    }
  }

  if (settings.error && !s) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Daemon not reachable</AlertTitle>
        <AlertDescription>
          Start it with <code>bun run daemon --bg</code>. ({settings.error.message})
        </AlertDescription>
      </Alert>
    );
  }

  const h = hooks.data;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Daemon</CardTitle>
          <CardDescription>Saved to the daemon's config file (mode 0600).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {s?.envOverrides.length ? (
            <Alert>
              <AlertDescription>
                Pinned by environment variables (file value ignored): {s.envOverrides.join(", ")}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="roots">Root folders (one per line)</Label>
            <Textarea
              id="roots"
              rows={4}
              value={roots}
              onChange={(e) => setRoots(e.target.value)}
              placeholder="~/Projects"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="port">Port</Label>
            <Input
              id="port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="w-32"
            />
          </div>
          <Secret
            id="token"
            label="Token (devices must send it)"
            isSet={!!s?.hasToken}
            value={token}
            clear={clearToken}
            onValue={setToken}
            onClear={setClearToken}
          />
          <Secret
            id="key"
            label="OpenRouter API key (voice routing)"
            isSet={!!s?.hasOpenrouterKey}
            value={key}
            clear={clearKey}
            onValue={setKey}
            onClear={setClearKey}
          />
        </CardContent>
        <CardFooter>
          <Button onClick={save} disabled={saving || !loaded}>
            Save
          </Button>
        </CardFooter>
      </Card>

      {s?.trustAdvice ? (
        <Alert variant="destructive">
          <AlertTitle>Claude does not trust some projects</AlertTitle>
          <AlertDescription>
            <pre className="whitespace-pre-wrap text-xs">{s.trustAdvice}</pre>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Claude Code hooks</CardTitle>
          <CardDescription>
            Adds one fire-and-forget command per event to your Claude settings (a backup is made
            before each change).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {h
              ? Object.entries(h.events).map(([ev, st]) => (
                  <Badge
                    key={ev}
                    variant={
                      st === "installed" ? "default" : st === "partial" ? "outline" : "secondary"
                    }
                  >
                    {ev}: {st}
                  </Badge>
                ))
              : null}
          </div>
          {h && h.state !== "missing" && !h.portMatches ? (
            <p className="text-xs text-muted-foreground">
              Installed for port {h.port}, which differs from the saved port. Install again to
              update.
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="gap-2">
          <Button onClick={() => runHookAction("install")}>
            {h?.state === "installed" ? "Reinstall hooks" : "Install hooks"}
          </Button>
          <Button
            variant="outline"
            onClick={() => runHookAction("uninstall")}
            disabled={h?.state === "missing"}
          >
            Uninstall hooks
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
