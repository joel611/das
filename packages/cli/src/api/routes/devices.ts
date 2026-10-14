import { Hono } from "hono";

export type Device = { id: string; device: string; capabilities: string[]; connectedAt: number };

export const deviceRoutes = (devices: Map<string, Device>) =>
  new Hono().get("/", (c) => c.json([...devices.values()]));
