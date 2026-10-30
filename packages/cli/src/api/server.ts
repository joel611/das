import type { Server } from "bun";
import { Hono, type Context } from "hono";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { envOverrides, loadConfig, writeSettingsFile, type Config } from "../config";
import { computeDisplay, soundFor, type Signal } from "../display";
import { hooksStatus, installHooks, uninstallHooks } from "../hooks-install";
import { installOmp, ompStatus, uninstallOmp } from "../omp-extension";
import type { Project } from "../scanner";
import { emit, LogHub, type Logs } from "../logs";
import { jevDecider, jevIntentClassifier, type Decider, type IntentClassifier } from "../router";
import { SessionTracker, type HookPayload, type SessionState } from "../sessions";
import { claudeSpawner, type Spawner } from "../spawner";
import { isTrusted, trustAdvice, trustedPaths } from "../trust";
import { LimitsTracker } from "../limits";
import { startAppPoll } from "../app-usage";
import { startUsagePoll } from "../usage-api";
import { UsageTracker } from "../usage";
import type { Orchestrator } from "../orchestrator";
import type { Session } from "../sessions";
import { handleTranscript, type VoiceDeps, type VoiceOpts } from "../voice";
import { createCameraHub, deviceRoutes, type Device } from "./routes/devices";
import { projectRoutes } from "./routes/projects";

type Env = { Bindings: { srv: Server<{ id: string }> } };

/** Cap long strings (prompts, tool output) so hook payloads stay small in the Debug ring. */
const clip = (p: HookPayload): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(p).map(([k, v]) => [
      k,
      typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}…` : v,
    ]),
  );

const TOPIC = "sessions";
/** Per-connection topic: how a frame reaches exactly one device. */
const connTopic = (id: string) => `conn:${id}`;

type Opts = {
  port: number;
  token: string;
  /** Live token source (the daemon's config, so a reload applies at once). Overrides `token` when set. */
  getToken?: () => string;
  getProjects: () => Project[];
  decider?: Decider;
  /** Step one of routing. Defaults to Jev only alongside the Jev decider, so a stubbed decider is never preceded by a real API call. */
  classifyIntent?: IntentClassifier;
  spawner?: Spawner;
  decisionsLog?: string;
  /** Admin API: settings dir and Claude config dir. Without them the matching endpoints answer 501 (never guess a real path). */
  configDir?: string;
  claudeDir?: string;
  /** oh-my-pi agent dir. The das extension lives in its `extensions/` dir. Without it the `/admin/omp` endpoints answer 501. */
  ompDir?: string;
  usageApi?: () => boolean;
  /** Live switch for Stack-chan notification sounds (the daemon's config). Defaults to off. */
  soundEnabled?: () => boolean;
  /** Starts the pi orchestrator once the session tracker exists. Absent, or failing to start: requests go to the Jev path. */
  orchestrator?: (h: { getSessions: () => Session[] }) => Promise<Orchestrator>;
  /** Called with the new effective config after a settings save. */
  onSettings?: (c: Config) => void;
  /** Log sinks for api.log / ws.log. Omitted sinks log nothing (tests stay off the real log dir). */
  logs?: Logs;
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
  if (b?.usageApi !== undefined) {
    if (typeof b.usageApi !== "boolean") return { error: "usageApi must be a boolean" };
    patch.usageApi = b.usageApi;
  }
  if (b?.notificationSound !== undefined) {
    if (typeof b.notificationSound !== "boolean")
      return { error: "notificationSound must be a boolean" };
    patch.notificationSound = b.notificationSound;
  }
  if (b?.orchestrator !== undefined) {
    if (b.orchestrator !== "jev" && b.orchestrator !== "pi")
      return { error: "orchestrator must be jev or pi" };
    patch.orchestrator = b.orchestrator;
  }
  if (b?.orchestratorProvider !== undefined) {
    if (b.orchestratorProvider !== "openrouter" && b.orchestratorProvider !== "openai")
      return { error: "orchestratorProvider must be openrouter or openai" };
    patch.orchestratorProvider = b.orchestratorProvider;
  }
  // "" clears either back to its default.
  for (const k of ["orchestratorModel", "codexAuthFile"] as const) {
    if (b?.[k] === undefined) continue;
    if (typeof b[k] !== "string") return { error: `${k} must be a string` };
    patch[k] = b[k].trim();
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
  getToken,
  getProjects,
  decider = jevDecider,
  classifyIntent = decider === jevDecider ? jevIntentClassifier : undefined,
  spawner = claudeSpawner,
  decisionsLog,
  configDir,
  claudeDir,
  ompDir,
  usageApi,
  soundEnabled = () => false,
  onSettings,
  orchestrator: startOrchestrator,
  logs: sinks = {},
  trusted = cachedTrusted,
}: Opts) {
  const hub = new LogHub();
  const logs: Logs = { api: hub.tee("api", sinks.api), ws: hub.tee("ws", sinks.ws) };
  const tracker = new SessionTracker(getProjects);
  const voice: VoiceDeps = {
    decider,
    classifyIntent,
    getSessions: () => tracker.list(),
    spawner,
    getProjects,
    pending: new Map(),
    logPath: decisionsLog,
  };
  const orchestrator: Promise<Orchestrator | null> = startOrchestrator
    ? startOrchestrator({ getSessions: () => tracker.list() }).catch((e) => {
        emit(logs.api, { event: "orchestrator", msg: `failed to start, using Jev: ${e}` });
        return null;
      })
    : Promise.resolve(null);
  void orchestrator.then((o) => o && tracker.onChange((e) => o.onSession(e)));
  /** Dry runs stay on the Jev path: the orchestrator has no way to decide without acting. */
  const routeMessage = async (deviceKey: string, text: string, opts: VoiceOpts = {}) => {
    const o = opts.dryRun ? null : await orchestrator;
    return o ? o.handle(deviceKey, text) : handleTranscript(voice, deviceKey, text, opts);
  };
  const usage = new UsageTracker(
    join(claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
  );
  const limits = new LimitsTracker();
  if (usageApi && claudeDir)
    startUsagePoll({
      limits,
      claudeDir,
      enabled: usageApi,
      log: (msg) => emit(logs.api, { event: "usage-api", msg }),
    });
  // Only when the Claude dir is configured (the daemon does): tests and bare servers stay off the real one.
  if (claudeDir) {
    void usage.backfill();
    startAppPoll({ limits, claudeDir, log: (msg) => emit(logs.api, { event: "app-usage", msg }) });
  }

  let boundPort = port;
  const devices = new Map<string, Device>();
  const untrusted = () => {
    const t = trusted();
    return getProjects().filter((p) => !isTrusted(p.path, t));
  };

  const authorized = (req: Request) => {
    const t = getToken ? getToken() : token;
    return (
      !t ||
      req.headers.get("authorization") === `Bearer ${t}` ||
      new URL(req.url).searchParams.get("token") === t
    );
  };

  const settingsView = () => {
    const c = loadConfig(configDir);
    return {
      roots: c.roots,
      port: c.port,
      hasToken: !!c.token,
      hasOpenrouterKey: !!c.openrouterKey,
      usageApi: c.usageApi,
      notificationSound: c.notificationSound,
      orchestrator: c.orchestrator,
      orchestratorProvider: c.orchestratorProvider,
      orchestratorModel: c.orchestratorModel,
      codexAuthFile: c.codexAuthFile,
      envOverrides: envOverrides(),
      trustAdvice: trustAdvice(c.roots, getProjects(), trusted()),
    };
  };

  const app = new Hono<Env>();
  app.notFound((c) => c.text("not found", 404));

  // api.log: one line per request, after the response. Path only (no query string, so no token).
  app.use(async (c, next) => {
    const t0 = performance.now();
    await next();
    const path = new URL(c.req.url).pathname;
    // The Debug tab polls /v1/logs; logging that would feed itself.
    if (path === "/v1/logs") return;
    emit(logs.api, {
      method: c.req.method,
      path,
      status: c.res.status,
      ms: Math.round(performance.now() - t0),
    });
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Hook ingest: localhost only, never blocks the agent.
  app.post("/hooks/:event{\\w+}", async (c) => {
    if (!isLocal(c.env.srv.requestIP(c.req.raw)?.address)) return c.text("forbidden", 403);
    // A body of `null` or a non-object is not a hook payload.
    const body: unknown = await c.req.json().catch(() => null);
    const payload: HookPayload = body && typeof body === "object" ? body : {};
    const event = c.req.param("event");
    hub.push("hook", { agent: payload.agent ?? "claude", event, payload: clip(payload) });
    tracker.handleHook(event, payload);
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
  const ompRoute = (run: (dir: string, port: number) => unknown) => (c: Context) => {
    if (!ompDir) return c.text("omp dir not configured", 501);
    const port = configDir ? loadConfig(configDir).port : boundPort;
    try {
      return c.json(run(ompDir, port));
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
    }
  };
  admin.get(
    "/omp",
    ompRoute((ompDir, port) => ompStatus({ ompDir, port })),
  );
  admin.post(
    "/omp/install",
    ompRoute((ompDir, port) => installOmp({ ompDir, port })),
  );
  admin.delete(
    "/omp",
    ompRoute((ompDir) => uninstallOmp({ ompDir })),
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
      await routeMessage(`http:${body.device ?? "default"}`, String(body.text ?? ""), {
        dryRun: body.dryRun === true,
        debug: body.debug === true,
      }),
    );
  });
  v1.get("/logs", (c) => c.json(hub.since(Number(c.req.query("after")) || 0)));
  v1.get("/sessions", (c) => c.json(tracker.list()));
  v1.get("/usage", (c) => c.json({ ...usage.summary(), limits: limits.summary() }));
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
  /** Camera frames pushed by the mod while its camera is on, fanned out to viewers. */
  const camera = createCameraHub();
  const signalDevice = (id: string, signal: Signal) => {
    if (!devices.has(id)) return false;
    server.publish(connTopic(id), JSON.stringify({ type: "signal", ...signal }));
    wsLog("message", { dir: "out", conn: id, type: "signal" });
    return true;
  };
  v1.route("/devices", deviceRoutes(devices, signalDevice, camera));
  app.route("/v1", v1);

  // ws.log: lifecycle plus frame `type` in both directions, never payloads.
  const wsLog = (event: string, extra: Record<string, unknown> = {}) =>
    emit(logs.ws, { event, ...extra });
  const send = (
    ws: { data: { id: string }; send(s: string): unknown },
    frame: { type: string } & Record<string, unknown>,
  ) => {
    ws.send(JSON.stringify(frame));
    wsLog("message", { dir: "out", conn: ws.data.id, type: frame.type });
  };

  const server = Bun.serve({
    port,
    fetch(req, srv) {
      // Websocket upgrade needs the raw Bun server, so it stays outside the Hono app.
      if (new URL(req.url).pathname === "/v1/ws") {
        if (!authorized(req)) {
          wsLog("upgrade", { result: "rejected", status: 401 });
          return new Response("unauthorized", { status: 401 });
        }
        if (srv.upgrade(req, { data: { id: crypto.randomUUID() } })) {
          wsLog("upgrade", { result: "accepted" });
          return;
        }
        wsLog("upgrade", { result: "rejected", status: 426 });
        return new Response("expected websocket", { status: 426 });
      }
      return app.fetch(req, { srv });
    },
    websocket: {
      data: {} as { id: string },
      open(ws) {
        ws.subscribe(TOPIC);
        ws.subscribe(connTopic(ws.data.id));
        wsLog("open", { conn: ws.data.id });
      },
      close(ws, code) {
        wsLog("close", { conn: ws.data.id, device: devices.get(ws.data.id)?.device, code });
        devices.delete(ws.data.id);
        camera.drop(ws.data.id);
      },
      message(ws, raw) {
        // Binary messages are camera frames: [w u16le][h u16le][RGB332 pixels] (no base64/JSON on the device link).
        if (typeof raw !== "string") {
          wsLog("message", { dir: "in", conn: ws.data.id, type: "camera.frame" });
          const b = Buffer.from(raw);
          const [w, h] = b.length >= 4 ? [b.readUInt16LE(0), b.readUInt16LE(2)] : [0, 0];
          if (w && h && b.length === 4 + w * h)
            camera.push(ws.data.id, w, h, b.subarray(4).toString("base64"));
          return;
        }
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          wsLog("message", { dir: "in", conn: ws.data.id, type: "unparseable" });
          return;
        }
        wsLog("message", {
          dir: "in",
          conn: ws.data.id,
          type: typeof msg?.type === "string" ? msg.type : "unknown",
          device: devices.get(ws.data.id)?.device,
        });
        // button is a reserved no-op; unknown types ignored.
        if (msg?.type === "voice.transcript") {
          void routeMessage(`ws:${ws.data.id}`, String(msg.text ?? "")).then((r) =>
            send(ws, { type: "voice.reply", ...r }),
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
          wsLog("hello", { conn: ws.data.id, device: devices.get(ws.data.id)?.device });
          const sessions = tracker.list();
          send(ws, {
            type: "snapshot",
            projects: getProjects(),
            sessions,
            display: computeDisplay(sessions),
          });
        }
      },
    },
  });

  boundPort = server.port ?? port;
  const lastState = new Map<string, SessionState>();
  tracker.onChange((e) => {
    server.publish(
      TOPIC,
      JSON.stringify({ type: "delta", ...e, display: computeDisplay(tracker.list()) }),
    );
    wsLog("message", { dir: "out", type: "delta", subscribers: server.subscriberCount(TOPIC) });
    if ("removed" in e) {
      lastState.delete(e.removed);
      return;
    }
    const sound = soundFor(lastState.get(e.session.id), e.session.state);
    lastState.set(e.session.id, e.session.state);
    if (sound && soundEnabled()) {
      server.publish(TOPIC, JSON.stringify({ type: "sound", ...sound }));
      wsLog("message", { dir: "out", type: "sound", subscribers: server.subscriberCount(TOPIC) });
    }
  });

  return server;
}
