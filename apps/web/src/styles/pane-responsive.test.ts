import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Up to nine panes share a window: what a pane's content shows follows the PANE's width
// (`@container work-pane`, the one pane-level container), never the window's. The window's own
// parts (the top bar, the rail and the list column, dialogs, the phone) keep their media queries.
// Inventory: ux/reports/pane-responsive-report.md § 1.
const ROOT = resolve("apps/web/src");
const sheets = [...readdirSync(join(ROOT, "styles")).filter((name) => name.endsWith(".css")).map((name) => `styles/${name}`), "styles.css"];
const text = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every at-rule block of one kind, with its prelude and its body. */
function blocks(css: string, kind: "@media" | "@container"): { prelude: string; body: string }[] {
  const found: { prelude: string; body: string }[] = [];
  for (let at = css.indexOf(kind); at >= 0; at = css.indexOf(kind, at + 1)) {
    const open = css.indexOf("{", at);
    let depth = 1, end = open + 1;
    while (depth > 0 && end < css.length) { if (css[end] === "{") depth += 1; else if (css[end] === "}") depth -= 1; end += 1; }
    found.push({ prelude: css.slice(at + kind.length, open).trim(), body: css.slice(open + 1, end - 1) });
  }
  return found;
}
const windowWidth = (prelude: string) => /width/.test(prelude);

// What each moved rule styles (a selector it carries), and its threshold against the pane.
const MOVED: { sheet: string; selector: string; prelude: string }[] = [
  { sheet: "styles/hig-chat.css", selector: ".hig-composer .composer-bar", prelude: "work-pane (max-width: 743px)" },
  { sheet: "styles/hig-chat.css", selector: ".transcript .transcript-inner, .composer-area.column", prelude: "work-pane (max-width: 743px)" },
  { sheet: "styles/chat-note.css", selector: ".note-head", prelude: "work-pane (max-width: 743px)" },
  { sheet: "styles/hig-entry.css", selector: ".start-view.with-board", prelude: "work-pane (max-width: 743px)" },
  { sheet: "styles/companion.css", selector: ".beside-chat .note-title", prelude: "work-pane (min-width: 744px)" },
  { sheet: "styles/browser.css", selector: ".browser-toolbar", prelude: "work-pane (max-width: 820px)" },
  { sheet: "styles/terminal.css", selector: ".terminal-toolbar", prelude: "work-pane (max-width: 760px)" },
  { sheet: "styles/flow.css", selector: ".flow-cal", prelude: "work-pane (max-width: 720px)" },
  { sheet: "styles/groups.css", selector: ".view-tools", prelude: "work-pane (max-width: 720px)" },
  { sheet: "styles/views.css", selector: ".home-modes", prelude: "work-pane (max-width: 720px)" },
  { sheet: "styles.css", selector: ".column", prelude: "work-pane (max-width: 720px)" },
  { sheet: "styles/hig-shell.css", selector: ".group-tabs .group-tab", prelude: "work-pane (width < 60rem)" },
];

describe("a pane's content follows the pane's width", () => {
  it.each(MOVED)("$sheet: $selector under @container $prelude", ({ sheet, selector, prelude }) => {
    const css = text(sheet);
    expect(blocks(css, "@container").some((block) => block.prelude === prelude && block.body.includes(selector))).toBe(true);
    // …and no longer under a window-width media query (the touch-pointer twin of the terminal's may stay).
    const byWindow = blocks(css, "@media").filter((block) => windowWidth(block.prelude) && block.body.includes(`${selector} {`));
    expect(byWindow.map((block) => block.prelude)).toEqual([]);
  });

  it("every pane-level container query names the one pane container", () => {
    const names = new Set(sheets.flatMap((sheet) => blocks(text(sheet), "@container").map((block) => /^([a-z-]+)\s*\(/.exec(block.prelude)?.[1] ?? "(unnamed)")));
    // work-pane: the pane; doc-tab, web-tab, pn: a surface inside it (the document, the web page, the project page); unnamed: a bento grid's own box.
    for (const name of names) expect(["(unnamed)", "doc-tab", "pn", "web-tab", "work-pane"]).toContain(name);
    expect(names.has("work-pane")).toBe(true);
    expect(text("styles/hig-workspace.css")).toMatch(/\.panes\.recursive \.pane \{ container-type: inline-size; container-name: work-pane; \}/);
    // Beside a web page or document the conversation has its column, not the pane: that column is the same container.
    expect(text("styles/companion.css")).toMatch(/\.beside:not\(\[data-fit="single"\]\) > \.beside-chat \{ container-type: inline-size; container-name: work-pane; \}/);
  });
});
