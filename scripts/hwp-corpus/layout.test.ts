import { describe, expect, it } from "vitest";
import { firstGlyphs, pageSummary, type LayoutRun } from "./layout.ts";

// A paragraph of two lines, then a table cell paragraph beside it on the first line.
const run = (text: string, y: number, charStart: number, extra: Partial<LayoutRun> = {}): LayoutRun => ({ text, x: 70 + charStart * 10, y, secIdx: 0, paraIdx: 0, charStart, ...extra });
const page = (secondLineStart: number) => [
  run("가나다라마 ", 100, 0),
  run("바사아", 120, secondLineStart),
  run("셀 글자", 100, 0, { parentParaIdx: 1, controlIdx: 0, cellIdx: 1, cellParaIdx: 0, cellPath: [{ controlIndex: 0, cellIndex: 1, cellParaIndex: 0 }] }),
];

describe("page summary", () => {
  it("records where lines break, so a line breaking one word earlier differs with the same line count", () => {
    const before = pageSummary(page(6)), after = pageSummary(page(4));
    expect(after.lines).toBe(before.lines);
    expect(after.paragraphs).toBe(before.paragraphs);
    expect(after.breaks).not.toBe(before.breaks);
    expect(pageSummary(page(6)).breaks).toBe(before.breaks);
  });

  it("does not depend on how a line is split into runs of different character shapes", () => {
    const split = [run("가나다", 100, 0), run("라마 ", 100, 3), run("바사아", 120, 6)];
    const whole = [run("가나다라마 ", 100, 0), run("바사아", 120, 6)];
    expect(pageSummary(split).breaks).toBe(pageSummary(whole).breaks);
  });

  it("keeps no text of the document: page 1's first characters become one hash plus positions", () => {
    const glyphs = firstGlyphs(page(6), 4, "salt");
    expect(glyphs.count).toBe(4);
    expect(glyphs.xy).toEqual([[70, 100], [70, 100], [70, 100], [70, 100]]);
    expect(glyphs.sha256).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.stringify([glyphs, pageSummary(page(6))]);
    for (const char of "가나다라바사아셀") expect(stored).not.toContain(char);
    expect(firstGlyphs([run("가나다X", 100, 0)], 4, "salt").sha256).not.toBe(glyphs.sha256);
  });

  it("salts page 1's hash with the document's whole-text hash, so a short first line cannot be guessed alone", () => {
    const runs = [run("가나다", 100, 0)];
    expect(firstGlyphs(runs, 40, "a".repeat(64)).sha256).not.toBe(firstGlyphs(runs, 40, "b".repeat(64)).sha256);
    expect(firstGlyphs(runs, 40, "a".repeat(64)).sha256).toBe(firstGlyphs(runs, 40, "a".repeat(64)).sha256);
  });
});
