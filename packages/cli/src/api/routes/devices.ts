import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parseSignal, type Signal } from "../../display";

export type Device = { id: string; device: string; capabilities: string[]; connectedAt: number };

export type Frame = { jpeg: string; at: number };

/** Latest camera frame per device, plus live viewers that are pushed each new frame. */
export const createCameraHub = () => {
  const frames = new Map<string, Frame>();
  const viewers = new Map<string, Set<(f: Frame) => void>>();
  return {
    frames,
    push(id: string, jpeg: string) {
      const f = { jpeg, at: Date.now() };
      frames.set(id, f);
      for (const v of viewers.get(id) ?? []) v(f);
    },
    drop: (id: string) => frames.delete(id),
    /** Returns an unsubscribe fn, which reports the viewer count left. */
    watch(id: string, fn: (f: Frame) => void) {
      const set = viewers.get(id) ?? new Set();
      viewers.set(id, set);
      set.add(fn);
      return () => {
        set.delete(fn);
        if (!set.size) viewers.delete(id);
        return set.size;
      };
    },
  };
};
export type CameraHub = ReturnType<typeof createCameraHub>;

/** `send` delivers to one connection; false if it is gone. */
export const deviceRoutes = (
  devices: Map<string, Device>,
  send: (id: string, s: Signal) => boolean,
  camera: CameraHub,
) =>
  new Hono()
    .get("/", (c) => c.json([...devices.values()]))
    .get("/:id/camera", (c) => {
      const id = c.req.param("id");
      if (!devices.has(id)) return c.json({ error: "no such device" }, 404);
      return c.json(camera.frames.get(id) ?? null);
    })
    // Pushed live preview: one SSE event per frame. The camera is switched off once the last viewer leaves.
    .get("/:id/camera/stream", (c) => {
      const id = c.req.param("id");
      if (!devices.has(id)) return c.json({ error: "no such device" }, 404);
      return streamSSE(c, async (stream) => {
        let wake: (() => void) | undefined;
        let latest: Frame | undefined = camera.frames.get(id);
        const unwatch = camera.watch(id, (f) => {
          latest = f; // a slow viewer skips ahead rather than queueing frames
          wake?.();
        });
        const closed = new Promise<void>((r) => stream.onAbort(r));
        try {
          while (!stream.aborted && devices.has(id)) {
            if (latest) {
              const f = latest;
              latest = undefined;
              await stream.writeSSE({ data: JSON.stringify(f) });
              continue;
            }
            // Wake on a new frame; the timeout re-checks the device and keeps the connection alive.
            await Promise.race([new Promise<void>((r) => (wake = r)), closed, Bun.sleep(15_000)]);
            wake = undefined;
          }
        } finally {
          if (unwatch() === 0) send(id, { camera: false });
        }
      });
    })
    .post("/:id/signal", async (c) => {
      const id = c.req.param("id");
      if (!devices.has(id)) return c.json({ error: "no such device" }, 404);
      const signal = parseSignal(await c.req.json().catch(() => null));
      if (!signal)
        return c.json({ error: "expected { state, sound, light, servo, camera, say }" }, 400);
      return send(id, signal) ? c.json({ ok: true }) : c.json({ error: "no such device" }, 404);
    });
