// Dev helper: serve app/ui in a normal browser with a stand-in for Tauri's `invoke("api", ...)`,
// so the real UI files can be tested without the native window.
//   SERVER=http://127.0.0.1:4321 TOKEN=... bun scripts/dev-ui.ts   -> http://127.0.0.1:5199/console.html
import { join } from "node:path";

const SERVER = process.env.SERVER ?? "http://127.0.0.1:4321";
const TOKEN = process.env.TOKEN ?? "";
const UI = join(import.meta.dir, "../app/ui");

// Mirrors the Rust `api` command: same allow-list, same `{status, body}` result.
const SHIM = `window.__TAURI__ = { core: { invoke: async (cmd, args) => {
  const r = await fetch("/__invoke/" + cmd, { method: "POST", body: JSON.stringify(args) });
  if (!r.ok) throw await r.text();
  return r.json();
} } };`;

Bun.serve({
  port: Number(process.env.PORT ?? 5199),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__shim.js") return new Response(SHIM, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/__invoke/api" && req.method === "POST") {
      const { method, path, body } = await req.json();
      if (!(path.startsWith("/admin/") || path.startsWith("/v1/"))) return new Response("path not allowed", { status: 400 });
      const res = await fetch(SERVER + path, {
        method,
        body: body ?? undefined,
        headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return Response.json({ status: res.status, body: parsed });
    }
    const file = Bun.file(join(UI, url.pathname === "/" ? "index.html" : url.pathname));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    if (url.pathname.endsWith(".html") || url.pathname === "/") {
      return new Response((await file.text()).replace("</head>", '<script src="/__shim.js"></script></head>'), { headers: { "content-type": "text/html" } });
    }
    return new Response(file);
  },
});
console.log(`dev ui on http://127.0.0.1:${process.env.PORT ?? 5199}/console.html -> ${SERVER}`);
