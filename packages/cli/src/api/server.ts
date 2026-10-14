import type { Server } from "bun";
import { Hono, type Context } from "hono";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envOverrides, loadConfig, writeSettingsFile, type Config } from "../config";
import { computeDisplay } from "../display";
import { hooksStatus, installHooks, uninstallHooks } from "../hooks-install";
import type { Project } from "../scanner";
import { jevDecider, type Decider } from "../router";
import { SessionTracker, type HookPayload } from "../sessions";
import { claudeSpawner, type Spawner } from "../spawner";
import { isTrusted, trustAdvice, trustedPaths } from "../trust";
import { UsageTracker } from "../usage";
import { handleTranscript, type VoiceDeps } from "../voice";
import { deviceRoutes, type Device } from "./routes/devices";
import { projectRoutes } from "./routes/projects";

type Env = { Bindings: { srv: Server<{ id: string }> } };

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
  const usage = new UsageTracker(
    join(claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
  );
  // Only when the Claude dir is configured (the daemon does): tests and bare servers stay off the real one.
  if (claudeDir) void usage.backfill();

  let boundPort = port;
  const devices = new Map<string, Device>();
  const untrusted = () => {
    const t = trusted();
    return getProjects().filter((p) => !isTrusted(p.path, t));
  };

  const authorized = (req: Request) =>
    !token ||
    req.headers.get("authorization") === `Bearer ${token}` ||
    new URL(req.url).searchParams.get("token") === token;

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

  const app = new Hono<Env>();
  app.notFound((c) => c.text("not found", 404));

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Hook ingest: localhost only, never blocks the agent.
  app.post("/hooks/:event{\\w+}", async (c) => {
    if (!isLocal(c.env.srv.requestIP(c.req.raw)?.address)) return c.text("forbidden", 403);
    // A body of `null` or a non-object is not a hook payload.
    const body: unknown = await c.req.json().catch(() => null);
    const payload: HookPayload = body && typeof body === "object" ? body : {};
    tracker.handleHook(c.req.param("event"), payload);
    // Read the transcript after answering, so a large first read never delays the agent.
    setTimeout(() => usage.ingest(payload.session_id ?? "", payload.transcript_path), 0);
    return c.body(null, 204);
  });

  // Admin API: localhost only, plus the token when one is set. Secrets are write-only.
  const admin = new Hono<Env>();
  admin.use(async (c, next) => {
    if (!isLocal(c.env.srv.requestIP(c.req.raw)?.address)) return c.text("forbidden", 403);
    if (!authorized(c.req.raw)) return c.text("unauthorized", 401);
    await next();
  });
  admin.get("/settings", (c) => {
    if (!configDir) return c.text("settings dir not configured", 501);
    return c.json(settingsView());
  });
  admin.put("/settings", async (c) => {
    if (!configDir) return c.text("settings dir not configured", 501);
    const parsed = parseSettings(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    writeSettingsFile(parsed.patch, configDir);
    const next = loadConfig(configDir);
    token = next.token;
    onSettings?.(next);
    return c.json({ ...settingsView(), restartRequired: next.port !== boundPort });
  });
  const hooksRoute = (run: (dir: string, port: number) => unknown) => (c: Context) => {
    if (!claudeDir) return c.text("claude dir not configured", 501);
    const port = configDir ? loadConfig(configDir).port : boundPort;
    try {
      return c.json(run(claudeDir, port));
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
    }
  };
  admin.get(
    "/hooks",
    hooksRoute((claudeDir, port) => hooksStatus({ claudeDir, port })),
  );
  admin.post(
    "/hooks/install",
    hooksRoute((claudeDir, port) => installHooks({ claudeDir, port })),
  );
  admin.delete(
    "/hooks",
    hooksRoute((claudeDir) => uninstallHooks({ claudeDir })),
  );
  app.route("/admin", admin);

  const v1 = new Hono<Env>();
  v1.use(async (c, next) => {
    if (!authorized(c.req.raw)) return c.text("unauthorized", 401);
    await next();
  });
  v1.post("/voice", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    return c.json(
      await handleTranscript(voice, `http:${body.device ?? "default"}`, String(body.text ?? ""), {
        dryRun: body.dryRun === true,
        debug: body.debug === true,
      }),
    );
  });
  v1.get("/sessions", (c) => c.json(tracker.list()));
  v1.get("/usage", (c) => c.json(usage.summary()));
  v1.get("/state", (c) => {
    const sessions = tracker.list();
    return c.json({
      display: computeDisplay(sessions),
      sessions: sessions.length,
      devices: devices.size,
      projects: getProjects().length,
      untrustedProjects: untrusted().length,
    });
  });
  v1.route("/projects", projectRoutes(getProjects));
  v1.route("/devices", deviceRoutes(devices));
  app.route("/v1", v1);

  const server = Bun.serve({
    port,
    fetch(req, srv) {
      // Websocket upgrade needs the raw Bun server, so it stays outside the Hono app.
      if (new URL(req.url).pathname === "/v1/ws") {
        if (!authorized(req)) return new Response("unauthorized", { status: 401 });
        if (srv.upgrade(req, { data: { id: crypto.randomUUID() } })) return;
        return new Response("expected websocket", { status: 426 });
      }
      return app.fetch(req, { srv });
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
