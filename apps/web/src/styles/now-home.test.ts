import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Skin 2 fix 1, design review finding 4: at 1000 and 760 the 지금 table kept five columns in a ≈ 680 px
// pane, and the 작업 column (the conversation's NAME) shrank to its icon. The table may keep five
// columns only where the name keeps a readable width; below that each conversation takes two lines.
// Read from the sheet itself: the fixed columns, the project's share, the two-line breakpoint.
const CSS = readFileSync(resolve("apps/web/src/styles/now-home.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rem = (selector: string): number[] => [...CSS.matchAll(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{\\s*width:\\s*([\\d.]+)rem`, "g"))].map((m) => Number(m[1]) * 16);
/** The narrowest width the conversation's name keeps in the five-column table (12rem: about ten Hangul syllables). */
const NAME_MIN = 12 * 16;

describe("지금's table keeps the conversation's name at every width", () => {
  it("switches to two-line rows wherever five columns would leave the name under 12rem", () => {
    const fixed = ["state", "ai", "time"].map((name) => rem(`.now-col-${name}`)[0]!);
    // The last column: the widest any table can have (a decision row once carried a second key here).
    const more = Math.max(...rem(".now-col-more"), ...rem(".now-table.with-decisions .now-col-more"));
    const share = Number(/\.now-col-project\s*\{\s*width:\s*([\d.]+)%/.exec(CSS)![1]) / 100;
    const needed = (fixed.reduce((a, b) => a + b, 0) + more + NAME_MIN) / (1 - share);
    const breakpoint = Number(/@container work-pane \(max-width:\s*(\d+)px\)\s*\{\s*\.now-table/.exec(CSS)![1]);
    expect({ breakpoint, fits: breakpoint >= needed }).toEqual({ breakpoint, fits: true });
  });
});

// Re-review 1, next round 3: in the two-line rows a conversation waiting for a decision drew its state
// word at the far right (its own template gave the state two tracks) while the others ended a column to
// the left — a ragged column of states. Every row variant puts the state in the same single track.
describe("지금's two-line rows keep their state words in one column", () => {
  it("every row template gives the state the same one track", () => {
    const narrow = CSS.slice(CSS.indexOf("@container work-pane (max-width"));
    const templates = [...narrow.matchAll(/(\.now-row[^{]*)\{[^}]*grid-template-areas:\s*((?:"[^"]*"\s*)+)/g)].map((m) => ({ rule: m[1]!.trim(), first: /"([^"]*)"/.exec(m[2]!)![1]!.split(/\s+/) }));
    expect(templates.length).toBeGreaterThan(0);
    const tracks = templates.map(({ rule, first }) => ({ rule, state: first.map((area, index) => (area === "state" ? index : -1)).filter((index) => index >= 0) }));
    for (const row of tracks) expect(row).toEqual({ rule: row.rule, state: tracks[0]!.state });
    expect(tracks[0]!.state).toHaveLength(1);
  });
});
