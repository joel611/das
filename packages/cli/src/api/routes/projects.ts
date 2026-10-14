import { Hono } from "hono";
import type { Project } from "../../scanner";

export const projectRoutes = (getProjects: () => Project[]) =>
  new Hono().get("/", (c) => c.json(getProjects()));
