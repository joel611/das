import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Token usage read from the Claude Code transcripts that hook events point at (`transcript_path`).
 * Each transcript is read incrementally from where the last read stopped. Plan limits (percent of the
 * 5-hour or weekly allowance) are not in transcripts, so `limits` stays null until something reports them.
 */

const HOUR = 3_600_000;
export const BLOCK_MS = 5 * HOUR;
const KEEP_MS = 24 * HOUR;
const BUCKET_MS = 5 * 60_000;

type Entry = {
  id: string;
  session: string;
  at: number;
  model: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
};

export type Usage = {
  block: {
    start: number;
    end: number;
    /** input + output + cache writes; cache reads are reported separately because they dwarf the rest */
    tokens: number;
    cacheRead: number;
    messages: number;
    /** tokens per minute over the last hour */
    burnPerMin: number;
    /** tokens per 5-minute bucket over the last hour, oldest first */
    series: number[];
    byModel: { model: string; tokens: number }[];
    bySession: { session: string; tokens: number }[];
  } | null;
  limits: null;
};

const total = (e: Entry) => e.input + e.output + e.cacheCreate;
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Short model family for display: "claude-opus-5-5" -> "opus". */
export const family = (model: string) =>
  model.match(/(opus|sonnet|haiku|fable)/i)?.[1].toLowerCase() ?? model;

/** Parse one transcript line; null unless it is an assistant message with usage. */
export function parseLine(line: string, session: string): Entry | null {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const m = d?.message;
  if (d?.type !== "assistant" || !m?.usage || typeof m.id !== "string") return null;
  const at = Date.parse(d.timestamp);
  if (!Number.isFinite(at) || m.model === "<synthetic>") return null;
  return {
    id: m.id,
    session,
    at,
    model: String(m.model ?? "unknown"),
    input: n(m.usage.input_tokens),
    output: n(m.usage.output_tokens),
    cacheCreate: n(m.usage.cache_creation_input_tokens),
    cacheRead: n(m.usage.cache_read_input_tokens),
  };
}

/** The active 5-hour block, ccusage-style: it starts at the hour of its first message and a new one starts after 5h or a 5h gap. */
export function activeBlock(sorted: Entry[], now: number) {
  let start = -Infinity;
  let last = -Infinity;
  let from = 0;
  sorted.forEach((e, i) => {
    if (e.at >= start + BLOCK_MS || e.at - last >= BLOCK_MS) {
      start = Math.floor(e.at / HOUR) * HOUR;
      from = i;
    }
    last = e.at;
  });
  if (!sorted.length || now >= start + BLOCK_MS) return null;
  return { start, end: start + BLOCK_MS, entries: sorted.slice(from) };
}

export class UsageTracker {
  /** message id -> entry; transcripts write one line per content block, so the last line for an id wins */
  private entries = new Map<string, Entry>();
  private offsets = new Map<string, { size: number; rest: string }>();

  /** Read whatever the transcript gained since the last call. Never throws. */
  ingest(session: string, path: string | undefined) {
    if (!session || !path) return;
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = fstatSync(fd).size;
      const seen = this.offsets.get(path) ?? { size: 0, rest: "" };
      if (size < seen.size) seen.size = 0; // truncated or replaced: start over
      if (size === seen.size) return;
      const buf = Buffer.alloc(size - seen.size);
      readSync(fd, buf, 0, buf.length, seen.size);
      const lines = (seen.rest + buf.toString("utf8")).split("\n");
      const rest = lines.pop() ?? "";
      for (const line of lines) {
        const e = parseLine(line, session);
        if (e) this.entries.set(e.id, e);
      }
      this.offsets.set(path, { size, rest });
    } catch {
      // missing or unreadable transcript: usage just stays unknown
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    this.prune();
  }

  private prune(now = Date.now()) {
    for (const [id, e] of this.entries) if (now - e.at > KEEP_MS) this.entries.delete(id);
  }

  summary(now = Date.now()): Usage {
    const sorted = [...this.entries.values()].sort((a, b) => a.at - b.at);
    const block = activeBlock(sorted, now);
    if (!block) return { block: null, limits: null };
    const sum = (key: (e: Entry) => string) => {
      const m = new Map<string, number>();
      for (const e of block.entries) m.set(key(e), (m.get(key(e)) ?? 0) + total(e));
      return [...m].sort((a, b) => b[1] - a[1]);
    };
    const series = Array.from({ length: HOUR / BUCKET_MS }, () => 0);
    let lastHour = 0;
    for (const e of sorted) {
      const age = now - e.at;
      if (age < 0 || age >= HOUR) continue;
      lastHour += total(e);
      series[series.length - 1 - Math.floor(age / BUCKET_MS)] += total(e);
    }
    return {
      block: {
        start: block.start,
        end: block.end,
        tokens: block.entries.reduce((a, e) => a + total(e), 0),
        cacheRead: block.entries.reduce((a, e) => a + e.cacheRead, 0),
        messages: block.entries.length,
        burnPerMin: Math.round(lastHour / 60),
        series,
        byModel: sum((e) => family(e.model)).map(([model, tokens]) => ({ model, tokens })),
        bySession: sum((e) => e.session).map(([session, tokens]) => ({ session, tokens })),
      },
      limits: null,
    };
  }
}
