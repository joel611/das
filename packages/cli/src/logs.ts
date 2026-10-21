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

export type LogSource = "ws" | "api" | "hook";
export type LogEntry = { seq: number; time: string; source: LogSource; [k: string]: unknown };

const SECRET_KEYS = new Set(["authorization", "token"]);

/** In-memory ring of recent WS/API/hook log entries: backs the Debug tab. Hook payloads live here only, never on disk. */
export class LogHub {
  private entries: LogEntry[] = [];
  private seq = 0;
  constructor(private readonly cap = 200) {}

  push(source: LogSource, obj: Record<string, unknown>) {
    const clean = Object.fromEntries(Object.entries(obj).filter(([k]) => !SECRET_KEYS.has(k)));
    this.entries.push({ ...clean, seq: ++this.seq, time: new Date().toISOString(), source });
    if (this.entries.length > this.cap) this.entries.shift();
  }

  /** Entries with seq > `after`, oldest first. `after = 0` replays the whole ring. */
  since(after = 0): LogEntry[] {
    return this.entries.filter((e) => e.seq > after);
  }

  /** A sink that records into the ring, then forwards to `next` (if any). */
  tee(source: "ws" | "api", next?: LogSink): LogSink {
    return {
      info: (obj) => {
        this.push(source, obj);
        next?.info(obj);
      },
    };
  }
}

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
