import { config } from "./config";
import { computeDisplay } from "./display";
import { scan, type Project } from "./scanner";
import { jevDecider, type Decider } from "./router";
import { SessionTracker } from "./sessions";
import { claudeSpawner, type Spawner } from "./spawner";
import { handleTranscript, type VoiceDeps } from "./voice";

const TOPIC = "sessions";

type Opts = {
  port: number;
  token: string;
  getProjects: () => Project[];
  decider?: Decider;
  spawner?: Spawner;
  decisionsLog?: string;
};

export function createServer({ port, token, getProjects, decider = jevDecider, spawner = claudeSpawner, decisionsLog }: Opts) {
  const voice: VoiceDeps = { decider, spawner, getProjects, pending: new Map(), logPath: decisionsLog };
  const tracker = new SessionTracker(getProjects);

  const authorized = (req: Request, url: URL) =>
    !token ||
    req.headers.get("authorization") === `Bearer ${token}` ||
    url.searchParams.get("token") === token;

  const server = Bun.serve({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // Hook ingest: localhost only, never blocks the agent.
      const hook = url.pathname.match(/^\/hooks\/(\w+)$/);
      if (hook && req.method === "POST") {
        const ip = srv.requestIP(req)?.address;
        if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
          return new Response("forbidden", { status: 403 });
        }
        tracker.handleHook(hook[1], await req.json().catch(() => ({})));
        return new Response(null, { status: 204 });
      }

      if (url.pathname.startsWith("/v1/")) {
        if (!authorized(req, url)) return new Response("unauthorized", { status: 401 });
        if (url.pathname === "/v1/ws") {
          if (srv.upgrade(req, { data: { id: crypto.randomUUID() } })) return;
          return new Response("expected websocket", { status: 426 });
        }
        if (url.pathname === "/v1/voice" && req.method === "POST") {
          const body: any = await req.json().catch(() => ({}));
          return Response.json(await handleTranscript(voice, `http:${body.device ?? "default"}`, String(body.text ?? "")));
        }
        if (url.pathname === "/v1/projects") return Response.json(getProjects());
        if (url.pathname === "/v1/sessions") return Response.json(tracker.list());
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      data: {} as { id: string },
      open(ws) {
        ws.subscribe(TOPIC);
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
          const sessions = tracker.list();
          ws.send(
            JSON.stringify({ type: "snapshot", projects: getProjects(), sessions, display: computeDisplay(sessions) }),
          );
        }
      },
    },
  });

  tracker.onChange((e) => {
    server.publish(TOPIC, JSON.stringify({ type: "delta", ...e, display: computeDisplay(tracker.list()) }));
  });

  return server;
}

if (import.meta.main) {
  let projects: Project[] = [];
  const rescan = () => (projects = scan(config.roots));
  rescan();
  setInterval(rescan, 60_000);
  const server = createServer({ port: config.port, token: config.token, getProjects: () => projects });
  console.log(`stack-chan-server on :${server.port}, roots: ${config.roots.join(", ")}, ${projects.length} projects`);
}
