import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { claimInstance } from "./instance.ts";
import { EventBus } from "../bus.ts";

test("another launcher cannot open a live host's data and an old owner cannot release its successor", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-host-lock-"));
  try {
    const first = claimInstance(dir, "fixture", "service");
    expect(() => claimInstance(dir, "fixture", "service")).toThrow(/이미 실행/);
    first.release();
    const next = claimInstance(dir, "fixture", "service");
    first.release();
    expect(() => claimInstance(dir, "fixture", "service")).toThrow(/이미 실행/);
    next.release();
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("events reset after a host restart even when the sequence number happens to match", () => {
  const first = new EventBus(2, "old"), next = new EventBus(2, "new");
  expect(first.replay(0, "old")).toEqual([]);
  expect(next.replay(0, "old")).toBeNull();
  expect(next.replay(20)).toBeNull();
  expect(next.replay(NaN)).toBeNull();
});
