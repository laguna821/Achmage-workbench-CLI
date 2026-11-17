import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGED_MS, CostBook, DEFAULT_COST, GiB, MiB, ceilingFor, estimate, lineOrder, neverWaits, nextToStart, pressureAfter, reserveFor,
  type Waiting,
} from "./core.ts";

describe("the limit (자동)", () => {
  it("is what the memory allows after the reserve, divided by one turn's cost", () => {
    // 16 GiB machine, 10 GiB available, nothing running, cost 450 MiB: reserve 1.6 GiB → (10 − 1.6) / 0.44 → 19.
    const facts = { totalBytes: 16 * GiB, availableBytes: 10 * GiB, cores: 8 };
    const result = estimate(facts, { runningTreeBytes: 0, costBytes: 450 * MiB });
    expect(result.reserveBytes).toBe(reserveFor(16 * GiB));
    expect(result.comfortable).toBe(Math.floor((10 * GiB - reserveFor(16 * GiB)) / (450 * MiB)));
    expect(result.limit).toBe(Math.min(result.comfortable, ceilingFor(8)));
    // The three numbers the settings show add up: total − other = what the turns may use.
    expect(result.totalBytes - result.otherBytes).toBe(10 * GiB - reserveFor(16 * GiB));
  });
  it("counts the memory running turns already hold as theirs (not as taken by others)", () => {
    const facts = { totalBytes: 16 * GiB, availableBytes: 4 * GiB, cores: 8 };
    const without = estimate(facts, { runningTreeBytes: 0, costBytes: 500 * MiB });
    const withTurns = estimate(facts, { runningTreeBytes: 2 * GiB, costBytes: 500 * MiB });
    expect(withTurns.limit).toBeGreaterThan(without.limit);
    expect(withTurns.limit).toBe(Math.floor((6 * GiB - reserveFor(16 * GiB)) / (500 * MiB)));
  });
  it("is never below 1 and never above the ceiling from the cores", () => {
    expect(estimate({ totalBytes: 4 * GiB, availableBytes: 200 * MiB, cores: 2 }, { runningTreeBytes: 0, costBytes: 450 * MiB }).limit).toBe(1);
    expect(estimate({ totalBytes: 256 * GiB, availableBytes: 250 * GiB, cores: 4 }, { runningTreeBytes: 0, costBytes: 300 * MiB }).limit).toBe(ceilingFor(4));
    expect(ceilingFor(1)).toBe(2);
    expect(ceilingFor(8)).toBe(16);
    expect(ceilingFor(64)).toBe(32);
  });
  it("직접: the person's number, kept between 1 and the maximum", () => {
    const facts = { totalBytes: 16 * GiB, availableBytes: 10 * GiB, cores: 8 };
    expect(estimate(facts, { runningTreeBytes: 0, costBytes: 450 * MiB }, { mode: "manual", manual: 3 }).limit).toBe(3);
    expect(estimate(facts, { runningTreeBytes: 0, costBytes: 450 * MiB }, { mode: "manual", manual: 0 }).limit).toBe(1);
    expect(estimate(facts, { runningTreeBytes: 0, costBytes: 450 * MiB }, { mode: "manual", manual: 999 }).limit).toBe(32);
  });
});

const w = (id: string, at: number, extra: Partial<Waiting> = {}): Waiting => ({ sessionId: `s-${id}`, requestId: id, at, shown: false, ...extra });

describe("the line", () => {
  it("is in the order asked, the conversation on screen first", () => {
    const now = 100_000;
    const order = lineOrder([w("a", 1000), w("b", 2000, { shown: true }), w("c", 3000), w("d", 4000, { shown: true })], now);
    expect(order.map((entry) => entry.requestId)).toEqual(["b", "d", "a", "c"]);
  });
  it("puts a request that has waited long first, on screen or not (no one waits forever behind the screen)", () => {
    const now = AGED_MS + 10_000;
    const order = lineOrder([w("old", 1000), w("shown", now - 1000, { shown: true })], now);
    expect(order.map((entry) => entry.requestId)).toEqual(["old", "shown"]);
  });
  it("one conversation's requests keep their own order (only its first one stands in the line)", () => {
    const order = lineOrder([w("x2", 2000, { sessionId: "s-x" }), w("x1", 1000, { sessionId: "s-x" }), w("y", 1500)], 10_000);
    expect(order.map((entry) => entry.requestId)).toEqual(["x1", "y"]);
  });
});

describe("who starts when a slot frees", () => {
  const base = { limit: 2, pressure: false };
  it("a free slot → the head of the line", () => {
    expect(nextToStart({ ...base, running: [{ forced: false }], line: lineOrder([w("a", 1), w("b", 2)], 10) }, 10)?.requestId).toBe("a");
  });
  it("no free slot → nobody", () => {
    expect(nextToStart({ ...base, running: [{ forced: false }, { forced: false }], line: [w("a", 1)] }, 10)).toBeNull();
  });
  it("지금 바로 실행 turns count as running", () => {
    expect(nextToStart({ ...base, running: [{ forced: true }, { forced: false }], line: [w("a", 1)] }, 10)).toBeNull();
  });
  it("fairness: once the head has waited long, forced turns no longer keep it out", () => {
    const now = AGED_MS + 5;
    const running = [{ forced: true }, { forced: true }, { forced: true }, { forced: false }];
    expect(nextToStart({ ...base, running, line: [w("a", 1)] }, now)?.requestId).toBe("a");
    // …but the ordinary turns still fill the limit: nothing more than the limit of those.
    expect(nextToStart({ ...base, running: [...running, { forced: false }], line: [w("a", 1)] }, now)).toBeNull();
  });
  it("under memory pressure nothing new starts — unless nothing runs at all (never below one)", () => {
    expect(nextToStart({ limit: 4, pressure: true, running: [{ forced: false }], line: [w("a", 1)] }, 10)).toBeNull();
    expect(nextToStart({ limit: 4, pressure: true, running: [], line: [w("a", 1)] }, 10)?.requestId).toBe("a");
  });
});

describe("what never waits", () => {
  it("answers, stops, steers and the plan's go-ahead pass; new turns ask", () => {
    for (const kind of ["approval", "question", "stop", "steer", "plan-go"] as const) expect(neverWaits(kind)).toBe(true);
    for (const kind of ["turn", "document", "schedule", "phone", "handover", "web"] as const) expect(neverWaits(kind)).toBe(false);
  });
});

describe("pressure", () => {
  const total = 16 * GiB;
  it("starts below the low mark and ends only a margin above it", () => {
    const low = Math.max(512 * MiB, total * 0.05);
    expect(pressureAfter(false, { totalBytes: total, availableBytes: low - 1, cores: 8 })).toBe(true);
    expect(pressureAfter(false, { totalBytes: total, availableBytes: low + 1, cores: 8 })).toBe(false);
    expect(pressureAfter(true, { totalBytes: total, availableBytes: low + 1, cores: 8 })).toBe(true);
    expect(pressureAfter(true, { totalBytes: total, availableBytes: low + 300 * MiB, cores: 8 })).toBe(false);
  });
});

describe("what one turn costs, learned", () => {
  it("starts from the default and says so", () => {
    const book = new CostBook(null);
    expect(book.figure("claude")).toEqual({ bytes: DEFAULT_COST.claude, learned: false, turns: 0 });
    expect(book.cost()).toEqual({ bytes: Math.max(DEFAULT_COST.claude, DEFAULT_COST.codex), learned: false });
  });
  it("is the mean of the last turns' peaks, and survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-costs-"));
    const file = join(dir, "resource-costs.json");
    const book = new CostBook(file);
    for (const peak of [600, 800, 1000]) book.record("claude", peak * MiB);
    expect(book.figure("claude")).toEqual({ bytes: 800 * MiB, learned: true, turns: 3 });
    const again = new CostBook(file);
    expect(again.figure("claude")).toEqual({ bytes: 800 * MiB, learned: true, turns: 3 });
    expect(again.cost()).toEqual({ bytes: 800 * MiB, learned: true });
    // Only the last 20 count.
    for (let index = 0; index < 25; index++) again.record("claude", 100 * MiB);
    expect(again.figure("claude").bytes).toBe(100 * MiB);
    expect(JSON.parse(readFileSync(file, "utf8")).claude.length).toBe(20);
  });
  it("ignores nonsense (zero, a broken file) and keeps a sane floor", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-costs-"));
    const file = join(dir, "resource-costs.json");
    writeFileSync(file, "{not json");
    const book = new CostBook(file);
    expect(book.figure("codex").learned).toBe(false);
    book.record("codex", 0);
    book.record("codex", Number.NaN);
    expect(book.figure("codex").learned).toBe(false);
    book.record("codex", 10 * MiB);
    expect(book.figure("codex").bytes).toBe(100 * MiB);
  });
});
