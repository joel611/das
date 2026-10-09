// Logging WebSocket proxy: client (Moddable sim) -> :4322 -> real server :4321.
// Lets us see what the simulator actually sends/receives without reading xsbug.
const UPSTREAM = process.env.UPSTREAM ?? "ws://127.0.0.1:4321/v1/ws";

Bun.serve<{ up: WebSocket; queue: string[] }>({
  port: 4322,
  fetch(req, srv) {
    const up = new WebSocket(UPSTREAM);
    return srv.upgrade(req, { data: { up, queue: [] } })
      ? undefined
      : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    open(ws) {
      console.log("[tap] client connected");
      ws.data.up.onopen = () => ws.data.queue.splice(0).forEach((m) => ws.data.up.send(m));
      ws.data.up.onmessage = (e) => {
        console.log("[tap] server -> client:", String(e.data).slice(0, 200));
        ws.send(String(e.data));
      };
    },
    message(ws, raw) {
      console.log("[tap] client -> server:", String(raw));
      ws.data.up.readyState === WebSocket.OPEN
        ? ws.data.up.send(String(raw))
        : ws.data.queue.push(String(raw));
    },
    close() {
      console.log("[tap] client closed");
    },
  },
});
console.log("[tap] listening :4322");
