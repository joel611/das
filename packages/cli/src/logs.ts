import { mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

/** Anything with `info(obj)`: a pino logger, or an in-memory sink in tests. */
export type LogSink = { info(obj: Record<string, unknown>): void };
export type Logs = { ws?: LogSink; api?: LogSink };

/** Call a sink without ever letting it break or slow the caller. */
export const emit = (sink: LogSink | undefined, obj: Record<string, unknown>) => {
  try {
    sink?.info(obj);
  } catch {
    // logging must never break a request
  }
};

const logsDir = (configDir: string) => join(configDir, "logs");

function makeLogger(configDir: string, name: "ws" | "api"): LogSink {
  const dir = join(logsDir(configDir), name);
  mkdirSync(dir, { recursive: true });
  // pino-roll keeps `current.log` next to the rotated files; expose it as <logs>/<name>.log.
  const link = join(logsDir(configDir), `${name}.log`);
  const target = join(name, "current.log");
  try {
    if (readlinkSync(link) !== target) throw new Error("stale");
  } catch {
    rmSync(link, { force: true });
    symlinkSync(target, link);
  }
  const stream = pino.transport({
    target: "pino-roll",
    options: {
      file: join(dir, name),
      extension: ".log",
      frequency: "daily",
      size: "10m",
      limit: { count: 7 },
      symlink: true,
      mkdir: true,
    },
  });
  stream.on("error", () => {}); // a dead log worker must not take the daemon down
  return pino(
    {
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: ["authorization", "headers.authorization", "token"],
    },
    stream,
  );
}

/** The real `ws.log` / `api.log` under `<configDir>/logs`. */
export function createLogs(configDir: string): Required<Logs> {
  return { ws: makeLogger(configDir, "ws"), api: makeLogger(configDir, "api") };
}

export const logsLocation = (configDir: string) => ({
  ws: join(logsDir(configDir), "ws.log"),
  api: join(logsDir(configDir), "api.log"),
});
