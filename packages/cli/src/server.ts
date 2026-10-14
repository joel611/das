import { statSync } from "node:fs";
import { homedir } from "node:os";
import { claudeCode } from "./agents/claude-code";
import { describe, type AgentProvider, type Integration, type Spawner } from "./agents/types";
import { envOverrides, loadConfig, writeSettingsFile, type Config } from "./config";
import { computeDisplay } from "./display";
import type { Project } from "./scanner";
import { jevDecider, type Decider } from "./router";
import { SessionTracker } from "./sessions";
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
  /** Agents that report to this daemon; the first is the default (legacy `/hooks/<event>`, voice spawns, trust). Defaults to Claude Code with `claudeDir`. */
  agents?: AgentProvider[];
  /** Admin API: settings dir and Claude config dir. Without them the matching endpoints answer 501 (never guess a real path). */
  configDir?: string;
  claudeDir?: string;
  /** Called with the new effective config after a settings save. */
  onSettings?: (c: Config) => void;
  trusted?: () => string[];
};

// Trust can live in a large file (~/.claude.json) and /v1/state is polled every couple of seconds.
function cachedTrusted(agent: AgentProvider) {
  let cache = { at: 0, paths: [] as string[] };
  return () => {
    if (Date.now() - cache.at > 5000)
      cache = { at: Date.now(), paths: agent.trust?.trusted() ?? [] };
    return cache.paths;
  };
}

type Device = { id: string; device: string; capabilities: string[]; connectedAt: number };

const noSpawn =
  (agent: AgentProvider): Spawner =>
  async () => {
    throw new Error(`${agent.name} cannot start sessions`);
  };

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
  spawner,
  decisionsLog,
  configDir,
  claudeDir,
  agents = [claudeCode({ claudeDir })],
  onSettings,
  trusted,
}: Opts) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const primary = agents[0];
  if (!primary) throw new Error("createServer needs at least one agent");
  trusted ??= cachedTrusted(primary);
  const voice: VoiceDeps = {
    decider,
    spawner: spawner ?? primary.spawn ?? noSpawn(primary),
    agentName: primary.name,
    getProjects,
    pending: new Map(),
    logPath: decisionsLog,
  };
  const tracker = new SessionTracker(getProjects);
  const usage = new UsageTracker();
  for (const a of agents) if (a.transcripts) usage.register(a.id, a.transcripts);
  // Each format decides whether it backfills (Claude Code only with an explicit claudeDir, so tests stay off the real one).
  void usage.backfill();

  let boundPort = port;
  const devices = new Map<string, Device>();
  const untrusted = () => {
    if (!primary.trust) return [];
    const t = trusted!();
    return getProjects().filter((p) => !primary.trust!.isTrusted(p.path, t));
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
      trustAdvice: primary.trust?.advice(c.roots, getProjects(), trusted!()) ?? null,
    };
  };

  const integration = (it: Integration, method: string, install: boolean) => {
    const port = configDir ? loadConfig(configDir).port : boundPort;
    try {
      if (method === "GET" && !install) return Response.json(it.status({ port }));
      if (method === "POST" && install) return Response.json(it.install({ port }));
      if (method === "DELETE" && !install) return Response.json(it.uninstall());
    } catch (e) {
      return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
    }
    return null;
  };

  const server = Bun.serve({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // Agent event ingest: `/hooks/<agent>/<event>`, or `/hooks/<event>` for the default agent
      // (where Claude Code hooks already post). Localhost only, never blocks the agent.
      const hook = url.pathname.match(/^\/hooks\/(?:([\w-]+)\/)?(\w+)$/);
      if (hook && req.method === "POST") {
        if (!isLocal(srv.requestIP(req)?.address))
          return new Response("forbidden", { status: 403 });
        const agent = hook[1] ? byId.get(hook[1]) : primary;
        if (!agent) return new Response("unknown agent", { status: 404 });
        const body: unknown = await req.json().catch(() => null);
        const signal = agent.parseEvent(hook[2], body);
        if (signal) {
          tracker.handle(agent.id, signal);
          // Read the transcript after answering, so a large first read never delays the agent.
          setTimeout(() => usage.ingest(agent.id, signal.session, signal.transcript), 0);
        }
        return new Response(null, { status: 204 });
      }

      // Admin API: localhost only, plus the token when one is set. Secrets are write-only.
      if (url.pathname.startsWith("/admin/")) {
        if (!isLocal(srv.requestIP(req)?.address))
          return new Response("forbidden", { status: 403 });
        if (!authorized(req, url)) return new Response("unauthorized", { status: 401 });
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
        // `/admin/agents/<id>/integration[/install]`, and `/admin/hooks[/install]` for the default agent.
        const integ =
          url.pathname.match(/^\/admin\/agents\/([\w-]+)\/integration(\/install)?$/) ??
          url.pathname.match(/^\/admin\/(hooks)(\/install)?$/);
        if (integ) {
          const agent = url.pathname.startsWith("/admin/hooks") ? primary : byId.get(integ[1]);
          if (!agent) return new Response("unknown agent", { status: 404 });
          if (!agent.integration)
            return new Response(`${agent.name} integration not configured`, { status: 501 });
          const res = integration(agent.integration, req.method, !!integ[2]);
          if (res) return res;
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
        if (url.pathname === "/v1/agents") return Response.json(agents.map(describe));
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
