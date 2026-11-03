import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExchangeStore } from "./exchanges";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const path = () => {
  const d = mkdtempSync(join(tmpdir(), "das-ex-"));
  dirs.push(d);
  return join(d, "exchanges.json");
};

test("open batch persists across a restart", () => {
  const p = path();
  new ExchangeStore(p).openQuestions("s1", ["a?", "b?"]);
  const again = new ExchangeStore(p);
  expect(again.open("s1")?.questions).toEqual(["a?", "b?"]);
  expect(again.open("s1")?.status).toBe("pending");
});

test("re-reading the same pending batch does not duplicate it", () => {
  const s = new ExchangeStore(path());
  expect(s.openQuestions("s1", ["a?"])).toBe(true);
  expect(s.openQuestions("s1", ["a?"])).toBe(false);
  expect(s.list("s1")).toHaveLength(1);
});

test("answer is persisted with provenance before delivery; second answer is rejected", () => {
  const p = path();
  const s = new ExchangeStore(p);
  s.openQuestions("s1", ["a?"]);
  expect(s.answer("s1", "yes", "user via desktop")).toEqual({ ok: true });
  expect(new ExchangeStore(p).open("s1")).toMatchObject({
    status: "answered",
    answer: "yes",
    provenance: "user via desktop",
  });
  expect(s.answer("s1", "no", "x")).toEqual({ ok: false, reason: "already answered" });
  s.markDelivered("s1");
  expect(s.open("s1")).toBeUndefined();
  expect(s.list("s1")[0]!.status).toBe("delivered");
});

test("answering with no open batch fails", () => {
  expect(new ExchangeStore(path()).answer("zz", "yes", "u")).toEqual({
    ok: false,
    reason: "no open question batch",
  });
});

test("cancel closes the batch; batches are per worker", () => {
  const s = new ExchangeStore(path());
  s.openQuestions("s1", ["a?"]);
  s.openQuestions("s2", ["b?"]);
  s.cancel("s1");
  expect(s.open("s1")).toBeUndefined();
  expect(s.open("s2")?.questions).toEqual(["b?"]);
});

test("a corrupt file starts empty", () => {
  const p = path();
  Bun.write(p, "{nope");
  expect(new ExchangeStore(p).list()).toEqual([]);
});
