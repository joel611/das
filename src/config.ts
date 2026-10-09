import { homedir } from "node:os";

const expand = (p: string) => (p.startsWith("~") ? homedir() + p.slice(1) : p);

export const config = {
  roots: (process.env.PROJECT_ROOTS ?? "~/Projects").split(",").map((r) => expand(r.trim())).filter(Boolean),
  port: Number(process.env.PORT ?? 4321),
  token: process.env.TOKEN ?? "",
};
