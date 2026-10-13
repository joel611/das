import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { activeBlock, family, parseLine, UsageTracker } from "./usage";

const dir = mkdtempSync(join(tmpdir(), "usage-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-11T10:20:00Z");
const line = (id: string, at: number, usage: object, model = "claude-opus-5-5") =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    message: { id, model, usage },
  }) + "\n";
const u = (input: number, output: number, cacheCreate = 0, cacheRead = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cacheCreate,
  cache_read_input_tokens: cacheRead,
});

test("parseLine keeps assistant messages with usage only", () => {
  expect(parseLine("garbage", "s")).toBeNull();
  expect(parseLine(JSON.stringify({ type: "user", message: {} }), "s")).toBeNull();
  expect(parseLine(line("m1", T0, u(1, 2, 3, 4)), "s")).toMatchObject({
    id: "m1",
    session: "s",
    input: 1,
    output: 2,
    cacheCreate: 3,
    cacheRead: 4,
  });
  expect(family("claude-sonnet-5-5")).toBe("sonnet");
});

test("blocks start on the hour and end after 5h or a 5h gap", () => {
  const e = (at: number) => ({ at }) as any;
  expect(activeBlock([], T0)).toBeNull();
  const b = activeBlock([e(T0), e(T0 + HOUR)], T0 + 2 * HOUR)!;
  expect(b.start).toBe(Date.parse("2026-10-11T10:00:00Z"));
  expect(b.entries).toHaveLength(2);
  // the block that started at 10:00 is over by 15:00, so 15:30 opens a new one
  expect(
    activeBlock([e(T0), e(T0 + 5 * HOUR + 10 * 60_000)], T0 + 5.5 * HOUR)!.entries,
  ).toHaveLength(1);
  expect(activeBlock([e(T0)], T0 + 6 * HOUR)).toBeNull();
});

test("ingest reads transcripts incrementally, dedupes message ids, sums the block", async () => {
  const path = join(dir, "a.jsonl");
  writeFileSync(path, line("m1", T0, u(10, 5, 100, 1000)) + line("m1", T0, u(10, 20, 100, 1000)));
  const t = new UsageTracker(dir, { now: () => T0 });
  await t.ingest("s1", path);
  appendFileSync(path, line("m2", T0 + 60_000, u(1, 1), "claude-haiku-5-5") + '{"partial');
  await t.ingest("s1", path);
  await t.ingest("s2", join(dir, "missing.jsonl"));
  const s = t.summary(T0 + 10 * 60_000).block!;
  expect(s.tokens).toBe(130 + 2);
  expect(s.cacheRead).toBe(1000);
  expect(s.messages).toBe(2);
  expect(s.byModel).toEqual([
    { model: "opus", tokens: 130 },
    { model: "haiku", tokens: 2 },
  ]);
  expect(s.bySession).toEqual([{ session: "s1", tokens: 132 }]);
  expect(s.series).toHaveLength(12);
  expect(s.series.slice(-3)).toEqual([130, 2, 0]);
  expect(t.summary(T0 + 6 * HOUR)).toEqual({ block: null, limits: null });
});

test("ingest only reads regular .jsonl files under the projects directory", async () => {
  const outside = mkdtempSync(join(tmpdir(), "usage-outside-"));
  const root = join(dir, "projects");
  mkdirSync(root);
  const evil = join(outside, "evil.jsonl");
  writeFileSync(evil, line("evil", T0, u(1, 1)));
  writeFileSync(join(root, "notes.txt"), line("txt", T0, u(1, 1)));
  symlinkSync(evil, join(root, "link.jsonl"));
  const fifo = join(root, "pipe.jsonl");
  spawnSync("mkfifo", [fifo]);
  const good = join(root, "good.jsonl");
  writeFileSync(good, line("ok", T0, u(2, 3)));

  const t = new UsageTracker(root, { now: () => T0 });
  await t.ingest("s", evil);
  await t.ingest("s", join(root, "notes.txt"));
  await t.ingest("s", join(root, "link.jsonl"));
  await t.ingest("s", fifo); // must return, not block on the open
  await t.ingest("s", `${root}/../${outside.split("/").pop()}/evil.jsonl`);
  expect(t.summary(T0 + 60_000).block).toBeNull();
  await t.ingest("s", good);
  expect(t.summary(T0 + 60_000).block?.tokens).toBe(5);
  rmSync(outside, { recursive: true, force: true });
});

test("ingest with no root reads nothing", async () => {
  const path = join(dir, "noroot.jsonl");
  writeFileSync(path, line("m", T0, u(1, 1)));
  const t = new UsageTracker(null, { now: () => T0 });
  await t.ingest("s", path);
  expect(t.summary(T0 + 60_000).block).toBeNull();
});

test("a multi-byte character split across read chunks survives", async () => {
  const path = join(dir, "utf8.jsonl");
  const text = "日本語".repeat(40);
  const l = JSON.stringify({
    type: "assistant",
    timestamp: new Date(T0).toISOString(),
    message: { id: "m", model: "claude-opus-5-5", usage: u(7, 0), note: text },
  });
  writeFileSync(path, l + "\n" + line("n", T0, u(1, 0)));
  const t = new UsageTracker(dir, { chunk: 7, now: () => T0 }); // 7 is not a multiple of 3, so chunks cut characters
  await t.ingest("s", path);
  expect(t.summary(T0 + 60_000).block?.tokens).toBe(8);
});

test("a truncated transcript restarts clean, without the old partial line", async () => {
  const path = join(dir, "trunc.jsonl");
  writeFileSync(path, line("a", T0, u(1, 0)) + '{"type":"assistant","partial');
  const t = new UsageTracker(dir, { now: () => T0 });
  await t.ingest("s", path);
  writeFileSync(path, line("b", T0, u(2, 0))); // shorter than before
  await t.ingest("s", path);
  expect(t.summary(T0 + 60_000).block?.tokens).toBe(3);
});

test("a replayed message id stays with the session that saw it first", async () => {
  const one = join(dir, "one.jsonl");
  const fork = join(dir, "fork.jsonl");
  writeFileSync(one, line("shared", T0, u(10, 0)));
  writeFileSync(fork, line("shared", T0, u(10, 0)) + line("own", T0 + 1000, u(5, 0)));
  const t = new UsageTracker(dir, { now: () => T0 });
  await t.ingest("s1", one);
  await t.ingest("s2", fork);
  const b = t.summary(T0 + 60_000).block!;
  expect(b.tokens).toBe(15);
  expect(b.bySession).toEqual([
    { session: "s1", tokens: 10 },
    { session: "s2", tokens: 5 },
  ]);
});

test("transcripts not read for a day are forgotten", async () => {
  const path = join(dir, "old.jsonl");
  writeFileSync(path, line("m", T0, u(1, 0)));
  let clock = T0;
  const t = new UsageTracker(dir, { now: () => clock });
  await t.ingest("s", path);
  expect((t as any).offsets.size).toBe(1);
  clock = T0 + 25 * HOUR;
  await t.ingest("s", join(dir, "missing.jsonl")); // any read triggers the sweep
  expect((t as any).offsets.size).toBe(0);
});

test("burn rate and series only count the active block", () => {
  // the previous block runs from 5h before T0's hour up to that hour; its last message is
  // 10 minutes before the active block starts, so it is inside "the last hour" but not this block
  const hour = Math.floor(T0 / HOUR) * HOUR;
  const t = new UsageTracker(dir, { now: () => T0 });
  (t as any).entries.set("first", parseLine(line("first", hour - 5 * HOUR, u(1, 0)), "s"));
  (t as any).entries.set("old", parseLine(line("old", hour - 10 * 60_000, u(50, 0)), "s"));
  (t as any).entries.set("new", parseLine(line("new", T0, u(7, 0)), "s"));
  const b = t.summary(T0 + 10 * 60_000).block!;
  expect(b.tokens).toBe(7);
  expect(b.series.reduce((a, x) => a + x, 0)).toBe(7);
  expect(b.burnPerMin).toBe(Math.round(7 / 60));
});

test("backfill reads transcripts changed within two blocks, named by session id", async () => {
  const sub = join(dir, "-Users-me-backfill");
  mkdirSync(sub);
  writeFileSync(join(sub, "recent.jsonl"), line("b1", T0, u(3, 0)));
  writeFileSync(join(sub, "stale.jsonl"), line("b2", T0, u(9, 0)));
  writeFileSync(join(sub, "notes.txt"), line("b3", T0, u(9, 0)));
  const old = new Date(T0 - 11 * HOUR);
  utimesSync(join(sub, "stale.jsonl"), old, old);
  utimesSync(join(sub, "recent.jsonl"), new Date(T0), new Date(T0));
  const t = new UsageTracker(dir, { now: () => T0 });
  await t.backfill();
  expect(t.summary(T0 + 60_000).block?.bySession).toContainEqual({ session: "recent", tokens: 3 });
  expect(t.summary(T0 + 60_000).block?.bySession.map((x) => x.session)).not.toContain("stale");
  await new UsageTracker(null).backfill(); // no root: nothing to read, no throw
});
