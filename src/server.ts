import { config } from "./config";
import { scan, type Project } from "./scanner";
import { SessionTracker } from "./sessions";

let projects: Project[] = [];
const rescan = () => (projects = scan(config.roots));
rescan();
setInterval(rescan, 60_000);

const tracker = new SessionTracker(() => projects);

const authorized = (req: Request) =>
  !config.token || req.headers.get("authorization") === `Bearer ${config.token}`;

const server = Bun.serve({
  port: config.port,
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
      if (!authorized(req)) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/v1/projects") return Response.json(projects);
      if (url.pathname === "/v1/sessions") return Response.json(tracker.list());
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`stack-chan-server on :${server.port}, roots: ${config.roots.join(", ")}, ${projects.length} projects`);
