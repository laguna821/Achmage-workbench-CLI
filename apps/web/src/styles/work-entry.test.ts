import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Skin 2 fix 1, the coordinator's ruling 4 (the design review's F-approval): the entry that waits for a
// decision drew a FILLED navy title bar inside an ink frame — navy outside the rail, two heavy boxes
// stacked. Now: a white head (its state glyph and words in the attention colour), a 1 px frame in a
// rule colour, and the navy 허용 the ONLY fill in the entry. Read from the sheet, light and dark.
const CSS = readFileSync(resolve("apps/web/src/styles/work-entry.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** Every declaration of `name` in the blocks whose selector list includes `selector`. */
function declared(selector: string, name: string): string[] {
  const out: string[] = [];
  for (const block of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = block[1]!.split(",").map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of block[2]!.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))) out.push(decl[1]!.trim());
  }
  return out;
}

describe("the waiting entry carries no navy fill and no ink frame", () => {
  const scopes = ['.entry[data-state="waiting"]', ':root[data-theme="dark"] .entry[data-state="waiting"]', '.look-scope[data-theme="dark"] .entry[data-state="waiting"]', '.entry[data-state="queued"]'];
  it.each(scopes)("%s", (selector) => {
    for (const fill of declared(selector, "--entry-head-fill")) expect(fill).not.toMatch(/--color-ink/);
    for (const ring of declared(selector, "--entry-ring")) expect(ring).not.toMatch(/--color-ink\)?$|--color-ink 58%/);
    for (const ink of declared(selector, "--entry-head-ink")) expect(ink).not.toMatch(/--color-paper/);
  });
});
