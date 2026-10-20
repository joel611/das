import { Hono } from "hono";
import { parseSignal, type Signal } from "../../display";

export type Device = { id: string; device: string; capabilities: string[]; connectedAt: number };

/** `send` delivers to one connection; false if it is gone. */
export const deviceRoutes = (
  devices: Map<string, Device>,
  send: (id: string, s: Signal) => boolean,
  frames: Map<string, { jpeg: string; at: number }>,
) =>
  new Hono()
    .get("/", (c) => c.json([...devices.values()]))
    .get("/:id/camera", (c) => {
      const id = c.req.param("id");
      if (!devices.has(id)) return c.json({ error: "no such device" }, 404);
      return c.json(frames.get(id) ?? null);
    })
    .post("/:id/signal", async (c) => {
      const id = c.req.param("id");
      if (!devices.has(id)) return c.json({ error: "no such device" }, 404);
      const signal = parseSignal(await c.req.json().catch(() => null));
      if (!signal)
        return c.json({ error: "expected { state, sound, light, servo, camera, say }" }, 400);
      return send(id, signal) ? c.json({ ok: true }) : c.json({ error: "no such device" }, 404);
    });
