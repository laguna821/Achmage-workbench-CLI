import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hwpMemoDatePatch, hwpMemoInstant } from "./hwp-memo-date.ts";

describe("a memo's date in the memo panel (rhwp 0.9.0: local time with a literal Z, as Hangul writes it)", () => {
  it("is the wall time the engine wrote, not that time moved by the time zone", () => {
    const shown = hwpMemoInstant("2026-11-14T17:39:05Z");
    expect([shown.getFullYear(), shown.getMonth() + 1, shown.getDate(), shown.getHours(), shown.getMinutes(), shown.getSeconds()]).toEqual([2026, 11, 14, 17, 39, 5]);
  });

  it("reads any other form as the browser does (an offset, no time, an extended year)", () => {
    expect(hwpMemoInstant("2026-11-14T08:39:05+00:00").getTime()).toBe(Date.UTC(2026, 10, 14, 8, 39, 5));
    expect(hwpMemoInstant("2026-11-14").getTime()).toBe(new Date("2026-11-14").getTime());
    expect(Number.isNaN(hwpMemoInstant("not a date").getTime())).toBe(true);
  });

  it("is what Ieum's memo panel uses, patched once, and the build fails when its text changed", () => {
    const source = readFileSync(resolve("vendor/ieumoffice/apps/hwp/src/renderer/MemoPanel.tsx"), "utf8");
    const patched = hwpMemoDatePatch(source, "/x/hwp-memo-date.ts");
    expect(patched.split("__workbenchMemoInstant(raw)").length).toBe(2);
    expect(patched).not.toContain("  const parsed = new Date(raw)\n");
    expect(patched.startsWith('import { hwpMemoInstant as __workbenchMemoInstant } from "/x/hwp-memo-date.ts"\n')).toBe(true);
    expect(() => hwpMemoDatePatch("nothing", "/x")).toThrow(/memo panel date reading changed/);
  });
});
