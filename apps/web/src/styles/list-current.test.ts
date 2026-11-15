import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Skin 2 fix 1, ruling 7: the list's current row kept its teal only while the column had the keyboard;
// with the focus in the work (the usual case) it went to a grey wash and a grey edge. It keeps its teal
// wash and mark at ALL times; without focus the wash is one step lighter — still teal, never grey.
const CSS = readFileSync(resolve("apps/web/src/styles/navigator.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
it("the unfocused column's current row is teal (wash and mark), not grey", () => {
  const unfocused = blocks.filter((b) => b.selector.includes(".nav-column:not(:focus-within)"));
  const washes = unfocused.flatMap((b) => [...b.body.matchAll(/--color-current-soft\s*:\s*([^;]+);/g)].map((m) => m[1]!));
  const marks = unfocused.flatMap((b) => [...b.body.matchAll(/--c-mark\s*:\s*([^;]+);/g)].map((m) => m[1]!));
  expect(washes.length + marks.length).toBeGreaterThan(0);
  // The last declaration wins in the sheet: it must be teal.
  if (washes.length) expect(washes.at(-1)).toMatch(/--color-teal/);
  if (marks.length) expect(marks.at(-1)).toMatch(/--color-teal/);
});

// Ruling 8: the muted group and section heads are 13 px (--text-label); 12 px stays for meta only.
it("the list's quiet heads are set at the 13 px label step, the last word in the sheet", () => {
  const heads = [".nav-folders-head", ".now-group-label", ".side-section-title", ".nav-inside-head .nav-fold", ".nav-group"];
  for (const head of heads) {
    const sizes = blocks.filter((b) => b.selector.split(",").some((part) => part.trim().endsWith(head)))
      .flatMap((b) => [...b.body.matchAll(/(?:^|;)\s*font(?:-size)?\s*:\s*([^;]+)/g)].map((m) => m[1]!));
    expect([head, sizes.at(-1)]).toEqual([head, expect.stringMatching(/--text-label/)]);
  }
});

// Technical review K2: the trailing fact (확인 필요 count, 진행 중 word) gave way to ⋯ also on `.focused`,
// the REMEMBERED list focus that stays after the keyboard left: the conversation just opened showed ⋯
// instead of its state while the person typed in the composer. Only the hand or the keyboard swaps them.
it("the trailing fact gives way to ⋯ only under the hand or the keyboard, never on the remembered focus", () => {
  const swaps = blocks.filter((b) => /\.row-more|side-row-trail > :not/.test(b.selector) && /:hover/.test(b.selector));
  expect(swaps.length).toBeGreaterThan(0);
  expect(swaps.filter((b) => b.selector.includes(".focused")).map((b) => b.selector)).toEqual([]);
});

// Technical review K3: marks whose meaning lives only in a tooltip (the link badge, the placement-rule mark)
// were hidden under the hand with the trailing fact — their tooltip could no longer be reached by mouse.
// ⋯ takes only the trailing word's or count's place.
it("the ⋯ swap never hides the link badge or the placement mark", () => {
  const swaps = blocks.filter((b) => /side-row-trail > :not\(/.test(b.selector) && /:hover/.test(b.selector));
  expect(swaps.length).toBeGreaterThan(0);
  for (const b of swaps) expect(b.selector).toMatch(/\.linked-badge/);
  for (const b of swaps) expect(b.selector).toMatch(/\.rule-mark/);
});
