import { statSync } from "node:fs";
import { homedir } from "node:os";
import { config, envOverrides, loadConfig, writeSettingsFile, type Config } from "./config";
import { computeDisplay } from "./display";
import { hooksStatus, installHooks, uninstallHooks } from "./hooks-install";
import type { Project } from "./scanner";
import { jevDecider, type Decider } from "./router";
import { SessionTracker, type HookPayload } from "./sessions";
import { claudeSpawner, type Spawner } from "./spawner";
import { isTrusted, trustAdvice, trustedPaths } from "./trust";
import { UsageTracker } from "./usage";
import { handleTranscript, type VoiceDeps } from "./voice";

const TOPIC = "sessions";

type Opts = {
  port: number;
  token: string;
  getProjects: () => Project[];
  decider?: Decider;
  spawner?: Spawner;
  decisionsLog?: string;
  /** Admin API: settings dir and Claude config dir. Without them the matching endpoints answer 501 (never guess a real path). */
  configDir?: string;
  claudeDir?: string;
  /** Called with the new effective config after a settings save. */
  onSettings?: (c: Config) => void;
  trusted?: () => string[];
};

// ~/.claude.json can be large and /v1/state is polled every couple of seconds.
let trustCache = { at: 0, paths: [] as string[] };
function cachedTrusted() {
  if (Date.now() - trustCache.at > 5000) trustCache = { at: Date.now(), paths: trustedPaths() };
  return trustCache.paths;
}

type Device = { id: string; device: string; capabilities: string[]; connectedAt: number };

const isLocal = (ip?: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
const expandHome = (p: string) => (p.startsWith("~") ? homedir() + p.slice(1) : p);
const isDir = (p: string) => {
  try {
    return statSync(expandHome(p)).isDirectory();
  } catch {
    return false;
  }
};

/** Validate a settings patch; returns the patch to persist or an error message. */
function parseSettings(b: any): { patch: Partial<Config> } | { error: string } {
  const patch: Partial<Config> = {};
  if (b?.roots !== undefined) {
    if (!Array.isArray(b.roots) || b.roots.some((r: unknown) => typeof r !== "string" || !r.trim()))
      return { error: "roots must be an array of non-empty strings" };
    const roots = b.roots.map((r: string) => r.trim());
    const bad = roots.find((r: string) => !isDir(r));
    if (bad) return { error: `root is not a directory: ${bad}` };
    patch.roots = roots;
  }
  if (b?.port !== undefined) {
    if (!Number.isInteger(b.port) || b.port < 1 || b.port > 65535)
      return { error: "port must be an integer 1-65535" };
    patch.port = b.port;
  }
  for (const k of ["token", "openrouterKey"] as const) {
    if (b?.[k] === undefined) continue;
    if (typeof b[k] !== "string") return { error: `${k} must be a string` };
    patch[k] = b[k];
  }
  return { patch };
}

export function createServer({
  port,
  token,
  getProjects,
  decider = jevDecider,
  spawner = claudeSpawner,
  decisionsLog,
  configDir,
  claudeDir,
  onSettings,
  trusted = cachedTrusted,
}: Opts) {
  const voice: VoiceDeps = {
    decider,
    spawner,
    getProjects,
    pending: new Map(),
    logPath: decisionsLog,
  };
  const tracker = new SessionTracker(getProjects);
  const usage = new UsageTracker();

  let boundPort = port;
  const devices = new Map<string, Device>();
  const untrusted = () => {
    const t = trusted();
    return getProjects().filter((p) => !isTrusted(p.path, t));
  };

  const authorized = (req: Request, url: URL) =>
    !token ||
    req.headers.get("authorization") === `Bearer ${token}` ||
    url.searchParams.get("token") === token;

  const settingsView = () => {
    const c = loadConfig(configDir);
    return {
      roots: c.roots,
      port: c.port,
      hasToken: !!c.token,
      hasOpenrouterKey: !!c.openrouterKey,
      envOverrides: envOverrides(),
      trustAdvice: trustAdvice(c.roots, getProjects(), trusted()),
    };
  };

  const server = Bun.serve({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // Hook ingest: localhost only, never blocks the agent.
      const hook = url.pathname.match(/^\/hooks\/(\w+)$/);
      if (hook && req.method === "POST") {
        if (!isLocal(srv.requestIP(req)?.address))
          return new Response("forbidden", { status: 403 });
        const payload: HookPayload = await req.json().catch(() => ({}));
        tracker.handleHook(hook[1], payload);
        // Read the transcript after answering, so a large first read never delays the agent.
        setTimeout(() => usage.ingest(payload.session_id ?? "", payload.transcript_path), 0);
        return new Response(null, { status: 204 });
      }

      // Admin API: localhost only, plus the token when one is set. Secrets are write-only.
      if (url.pathname.startsWith("/admin/")) {
        if (!isLocal(srv.requestIP(req)?.address))
          return new Response("forbidden", { status: 403 });
        if (!authorized(req, url)) return new Response("unauthorized", { status: 401 });
        const route = `${req.method} ${url.pathname}`;
        if (url.pathname === "/admin/settings") {
          if (!configDir) return new Response("settings dir not configured", { status: 501 });
          if (req.method === "GET") return Response.json(settingsView());
          if (req.method === "PUT") {
            const parsed = parseSettings(await req.json().catch(() => null));
            if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
            writeSettingsFile(parsed.patch, configDir);
            const next = loadConfig(configDir);
            token = next.token;
            onSettings?.(next);
            return Response.json({ ...settingsView(), restartRequired: next.port !== boundPort });
          }
        }
        if (url.pathname.startsWith("/admin/hooks")) {
          if (!claudeDir) return new Response("claude dir not configured", { status: 501 });
          const cfgPort = () => (configDir ? loadConfig(configDir).port : boundPort);
          try {
            if (route === "GET /admin/hooks")
              return Response.json(hooksStatus({ claudeDir, port: cfgPort() }));
            if (route === "POST /admin/hooks/install")
              return Response.json(installHooks({ claudeDir, port: cfgPort() }));
            if (route === "DELETE /admin/hooks")
              return Response.json(uninstallHooks({ claudeDir }));
          } catch (e) {
            return Response.json(
              { error: String(e instanceof Error ? e.message : e) },
              { status: 500 },
            );
          }
        }
        return new Response("not found", { status: 404 });
      }

      if (url.pathname.startsWith("/v1/")) {
        if (!authorized(req, url)) return new Response("unauthorized", { status: 401 });
        if (url.pathname === "/v1/ws") {
          if (srv.upgrade(req, { data: { id: crypto.randomUUID() } })) return;
          return new Response("expected websocket", { status: 426 });
        }
        if (url.pathname === "/v1/voice" && req.method === "POST") {
          const body: any = await req.json().catch(() => ({}));
          return Response.json(
            await handleTranscript(
              voice,
              `http:${body.device ?? "default"}`,
              String(body.text ?? ""),
              { dryRun: body.dryRun === true, debug: body.debug === true },
            ),
          );
        }
        if (url.pathname === "/v1/projects") return Response.json(getProjects());
        if (url.pathname === "/v1/sessions") return Response.json(tracker.list());
        if (url.pathname === "/v1/usage") return Response.json(usage.summary());
        if (url.pathname === "/v1/devices") return Response.json([...devices.values()]);
        if (url.pathname === "/v1/state") {
          const sessions = tracker.list();
          return Response.json({
            display: computeDisplay(sessions),
            sessions: sessions.length,
            devices: devices.size,
            projects: getProjects().length,
            untrustedProjects: untrusted().length,
          });
        }
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      data: {} as { id: string },
      open(ws) {
        ws.subscribe(TOPIC);
      },
      close(ws) {
        devices.delete(ws.data.id);
      },
      message(ws, raw) {
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        // button is a reserved no-op; unknown types ignored.
        if (msg?.type === "voice.transcript") {
          handleTranscript(voice, `ws:${ws.data.id}`, String(msg.text ?? "")).then((r) =>
            ws.send(JSON.stringify({ type: "voice.reply", ...r })),
          );
          return;
        }
        if (msg?.type === "hello") {
          devices.set(ws.data.id, {
            id: ws.data.id,
            device: String(msg.device ?? "unknown"),
            capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String) : [],
            connectedAt: devices.get(ws.data.id)?.connectedAt ?? Date.now(),
          });
          const sessions = tracker.list();
          ws.send(
            JSON.stringify({
              type: "snapshot",
              projects: getProjects(),
              sessions,
              display: computeDisplay(sessions),
            }),
          );
        }
      },
    },
  });

  boundPort = server.port ?? port;
  tracker.onChange((e) => {
    server.publish(
      TOPIC,
      JSON.stringify({ type: "delta", ...e, display: computeDisplay(tracker.list()) }),
    );
  });

  return server;
}
