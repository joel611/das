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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { JEV_STYLES, useJevStyle } from "@/lib/jev-style";
import {
  useHookAction,
  useHooks,
  useOmp,
  useOmpAction,
  useSaveSettings,
  useSettings,
} from "@/lib/queries";
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

/** Local display choice, so it works without the daemon and is not sent to it. */
function JevStyleCard() {
  const [style, setStyle] = useJevStyle();
  const current = JEV_STYLES.find((s) => s.id === style);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Jev animation</CardTitle>
        <CardDescription>
          How Jev is drawn on the Command tab. Saved on this machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div role="group" aria-label="Jev animation style" className="flex gap-2">
          {JEV_STYLES.map((s) => (
            <Button
              key={s.id}
              variant={s.id === style ? "default" : "outline"}
              aria-pressed={s.id === style}
              onClick={() => setStyle(s.id)}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{current?.hint}</p>
      </CardContent>
    </Card>
  );
}

/** Saves on toggle: the daemon applies it at once, no Save button. */
function StackchanCard({ enabled }: { enabled: boolean }) {
  const saveSettings = useSaveSettings();
  async function toggle(next: boolean) {
    try {
      await saveSettings.mutateAsync({ notificationSound: next });
    } catch (e) {
      toast.error(msg(e));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Stack-chan</CardTitle>
        <CardDescription>Settings for the stack-chan device.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-start gap-3">
        <Switch
          id="notification-sound"
          checked={enabled}
          disabled={saveSettings.isPending}
          onCheckedChange={toggle}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="notification-sound">Notification sound</Label>
          <p className="text-xs text-muted-foreground">
            Beep when a session starts waiting, finishes or fails.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function Settings() {
  const settings = useSettings(60_000);
  const hooks = useHooks();
  const omp = useOmp();
  const ompAction = useOmpAction();
  const saveSettings = useSaveSettings();
  const hookAction = useHookAction();

  const [roots, setRoots] = useState("");
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [usageApi, setUsageApi] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const saving = saveSettings.isPending;

  const s = settings.data;
  useEffect(() => {
    if (s && !loaded) {
      setRoots(s.roots.join("\n"));
      setPort(String(s.port));
      setUsageApi(s.usageApi);
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
      usageApi,
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

  async function runOmpAction(kind: "install" | "uninstall") {
    try {
      await ompAction.mutateAsync(kind);
      toast.success(
        kind === "install"
          ? "omp extension installed. Restart running omp sessions to load it."
          : "omp extension removed.",
      );
    } catch (e) {
      toast.error(msg(e));
    }
  }

  if (settings.error && !s) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <AlertTitle>Daemon not reachable</AlertTitle>
          <AlertDescription>
            Start it with <code>bun run daemon --bg</code>. ({settings.error.message})
          </AlertDescription>
        </Alert>
        <JevStyleCard />
      </div>
    );
  }

  const h = hooks.data;
  const o = omp.data;
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
          <div className="flex items-start gap-3">
            <Switch id="usage-api" checked={usageApi} onCheckedChange={setUsageApi} />
            <div className="flex flex-col gap-1">
              <Label htmlFor="usage-api">Poll the Claude usage API for plan limits</Label>
              <p className="text-xs text-muted-foreground">
                Fills in the 5-hour and weekly limits while no Claude session is running, using your
                Claude Code login (which only stays valid for a few hours after your last session).
                The endpoint is undocumented and rate limited, so it is checked at most every 5
                minutes. On macOS the first read of the login may ask for Keychain access.
              </p>
            </div>
          </div>
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

      <Card>
        <CardHeader>
          <CardTitle>oh-my-pi (omp) extension</CardTitle>
          <CardDescription>
            Writes one extension file into your omp agent dir that reports session events to the
            daemon.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {o ? (
              <Badge variant={o.state === "installed" ? "default" : "secondary"}>{o.state}</Badge>
            ) : null}
          </div>
          {o && o.state === "installed" && !o.portMatches ? (
            <p className="text-xs text-muted-foreground">
              Installed for port {o.port}, which differs from the saved port. Install again to
              update.
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="gap-2">
          <Button onClick={() => runOmpAction("install")}>
            {o?.state === "installed" ? "Reinstall omp extension" : "Install omp extension"}
          </Button>
          <Button
            variant="outline"
            onClick={() => runOmpAction("uninstall")}
            disabled={o?.state === "missing"}
          >
            Uninstall omp extension
          </Button>
        </CardFooter>
      </Card>
      {s ? (
        <StackchanCard enabled={s.notificationSound} />
      ) : null}
      <JevStyleCard />
    </div>
  );
}
