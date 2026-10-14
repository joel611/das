import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Token usage read from agent transcripts, incrementally from where the last read stopped. The core
 * reads JSONL files and aggregates; each agent's `TranscriptFormat` says where its transcripts live
 * and how one line maps to a usage entry. Plan limits (percent of the 5-hour or weekly allowance) are
 * not in transcripts, so `limits` stays null until something reports them.
 *
 * A transcript path comes from an event payload, which any local process can post, so it is only read
 * when it resolves to a regular `.jsonl` file under that agent's transcript root.
 */

const HOUR = 3_600_000;
export const BLOCK_MS = 5 * HOUR;
const KEEP_MS = 24 * HOUR;
const BUCKET_MS = 5 * 60_000;
/** Bytes read per step; a big transcript is read in several steps so nothing holds the event loop. */
const CHUNK = 1 << 20;
/** A single line longer than this is dropped rather than buffered. */
const MAX_LINE = 32 << 20;

export type Entry = {
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

/** How one agent writes transcripts. */
export type TranscriptFormat = {
  /** Directory every transcript must resolve under; anything outside it is ignored. */
  root: string;
  /** Parse one line; null unless it carries usage. `id` must be unique per model response. */
  parseLine(line: string, session: string): Entry | null;
  /** Transcripts of sessions active since `since`, read once at startup. Omit to skip backfill. */
  recent?(since: number): Promise<{ session: string; path: string }[]>;
};

const total = (e: Entry) => e.input + e.output + e.cacheCreate;

/** Short model family for display: "claude-opus-5-5" -> "opus". */
export const family = (model: string) =>
  model.match(/(opus|sonnet|haiku|fable)/i)?.[1].toLowerCase() ?? model;

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
  /** bytes consumed per transcript, plus the unfinished last line (kept as bytes: it may end mid-character) */
  private offsets = new Map<string, { size: number; rest: Buffer; at: number }>();
  /** reads run one at a time, so two hooks for one transcript never read the same bytes twice */
  private queue: Promise<void> = Promise.resolve();

  /** agent id -> its transcript format */
  private formats = new Map<string, TranscriptFormat>();

  constructor(private opts: { chunk?: number; now?: () => number } = {}) {}

  /** Read an agent's transcripts from now on. */
  register(agent: string, format: TranscriptFormat) {
    this.formats.set(agent, format);
  }

  /**
   * Read the transcripts of sessions that were already running when the daemon started, so the block
   * total is complete before their next event. Only what each format's `recent` lists, touched in the
   * last 5 hours. Never rejects.
   */
  async backfill(): Promise<void> {
    const since = this.now() - BLOCK_MS;
    for (const [agent, f] of this.formats) {
      const found = await f.recent?.(since).catch(() => []);
      for (const t of found ?? []) void this.ingest(agent, t.session, t.path);
    }
    await this.queue;
  }

  /** Read whatever the transcript gained since the last call. Never rejects. */
  ingest(agent: string, session: string, path: string | undefined): Promise<void> {
    const format = this.formats.get(agent);
    if (!format || !session || !path) return this.queue;
    this.queue = this.queue.then(() => this.read(format, session, path));
    return this.queue;
  }

  private async read(format: TranscriptFormat, session: string, path: string) {
    let fh;
    try {
      if (!path.endsWith(".jsonl")) return;
      const [root, real] = await Promise.all([realpath(format.root), realpath(path)]);
      if (!real.startsWith(root + sep)) return;
      // O_NONBLOCK so a FIFO planted at the path fails the isFile check instead of blocking the open.
      fh = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await fh.stat();
      if (!stat.isFile()) return;
      const seen = this.offsets.get(real);
      // Shorter than last time means truncated or replaced: start over, and drop the stale partial line.
      const fresh = !seen || stat.size < seen.size;
      let pos = fresh ? 0 : seen.size;
      let rest = fresh ? Buffer.alloc(0) : seen.rest;
      while (pos < stat.size) {
        const buf = Buffer.alloc(Math.min(this.opts.chunk ?? CHUNK, stat.size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const data = Buffer.concat([rest, buf.subarray(0, bytesRead)]);
        const nl = data.lastIndexOf(10);
        rest = nl < 0 ? data : data.subarray(nl + 1);
        if (rest.length > MAX_LINE) rest = Buffer.alloc(0);
        if (nl < 0) continue;
        for (const line of data.subarray(0, nl).toString("utf8").split("\n")) {
          const e = format.parseLine(line, session);
          if (!e) continue;
          // A forked or resumed session replays another session's messages under the same ids.
          // The session that saw an id first keeps it; later lines only update tokens within it.
          const owner = this.entries.get(e.id)?.session;
          if (owner === undefined || owner === session) this.entries.set(e.id, e);
        }
      }
      this.offsets.set(real, { size: pos, rest: Buffer.from(rest), at: this.now() });
    } catch {
      // missing or unreadable transcript: usage just stays unknown
    } finally {
      await fh?.close().catch(() => {});
      this.prune();
    }
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** Forget entries, and transcripts not read for a day, so neither map grows for the daemon's lifetime. */
  private prune(now = this.now()) {
    for (const [id, e] of this.entries) if (now - e.at > KEEP_MS) this.entries.delete(id);
    for (const [path, o] of this.offsets) if (now - o.at > KEEP_MS) this.offsets.delete(path);
  }

  summary(now = this.now()): Usage {
    const sorted = [...this.entries.values()].sort((a, b) => a.at - b.at);
    const block = activeBlock(sorted, now);
    if (!block) return { block: null, limits: null };
    const sum = (key: (e: Entry) => string) => {
      const m = new Map<string, number>();
      for (const e of block.entries) m.set(key(e), (m.get(key(e)) ?? 0) + total(e));
      return [...m].sort((a, b) => b[1] - a[1]);
    };
    // Only the active block: the previous block's tail would otherwise inflate the burn rate
    // and the sparkline while the totals above already exclude it.
    const series = Array.from({ length: HOUR / BUCKET_MS }, () => 0);
    let lastHour = 0;
    for (const e of block.entries) {
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
