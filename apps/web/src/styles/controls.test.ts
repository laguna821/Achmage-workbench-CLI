// Hallmark U2: one control family. The paint of every mapped control (keys, menu items, rows,
// tabs, segmented, chips, card links) lives in styles/controls.css; other sheets keep only its
// layout, or set the recipe's --c-* variables. No control is disabled by opacity alone.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const sheets = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sheets(path) : name.endsWith(".css") ? [path] : [];
});

const MAPPED = new Set(("button ghost-button text-button hk-btn hk-btn--filled hk-btn--tinted hk-btn--bordered hk-btn--plain icon-button "
  + "hig-icon-button hk-bar-btn select-button plain-select ui-select ui-stat-button pn-prop-button attention-button fork-button project-button "
  + "queue-button flow-feeds-button feature-pill ui-menu-item context-menu-item menu-item side-row outline-row hk-sidebar__item group-tab view-tab "
  + "hk-seg hk-seg__item hk-seg__indicator segmented filter-chip work-chip attach-chip attach-file-button note-prop doc-card ui-card session-card").split(" "));
const PAINT = /^(background(-color|-image)?|border-color|border-radius|box-shadow|color)$/;
// Drag-and-drop feedback and the high-contrast variants are not the control's look.
const EXEMPT = /drop-|dragging|renaming|creating|data-scope|keyed|::/;

/** Innermost style rules with their selector and declarations (comments removed; at-rules unwrapped). */
function rules(css: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string; media: string }[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i), close = text.indexOf("}", i);
    if (close !== -1 && (open === -1 || close < open)) { stack.pop(); i = close + 1; continue; }
    if (open === -1) break;
    const prelude = text.slice(i, open).trim().split(";").pop()!.trim();
    if (prelude.startsWith("@")) {
      if (/^@(media|supports|layer|container)/.test(prelude)) { stack.push(prelude); i = open + 1; continue; }
      let depth = 1, k = open + 1;
      while (k < text.length && depth) { if (text[k] === "{") depth++; else if (text[k] === "}") depth--; k++; }
      i = k; continue;
    }
    const end = text.indexOf("}", open);
    out.push({ selector: prelude, body: text.slice(open + 1, end), media: stack.join(" ") });
    i = end + 1;
  }
  return out;
}
/** The subject compound of each selector in a list (top-level commas and combinators only). */
function subjects(selector: string) {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of selector) {
    if ("([".includes(ch)) depth++;
    if (")]".includes(ch)) depth--;
    if (ch === "," && !depth) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((part) => {
    let d = 0, last = "";
    for (const ch of part.trim()) {
      if ("([".includes(ch)) d++;
      if (")]".includes(ch)) d--;
      if (!d && " >+~".includes(ch)) last = ""; else last += ch;
    }
    return last.replace(/:not\([^)]*\)/g, "");
  });
}

describe("one control family (styles/controls.css)", () => {
  const files = sheets(SRC).filter((file) => !/(controls|tokens)\.css$/.test(file));

  it("no other sheet paints a mapped control (they set --c-* variables or layout only)", () => {
    const offenders: string[] = [];
    for (const file of files) for (const rule of rules(readFileSync(file, "utf8"))) {
      if (/forced-colors|prefers-contrast/.test(rule.media) || EXEMPT.test(rule.selector)) continue;
      const mapped = subjects(rule.selector).some((subject) => [...subject.matchAll(/\.([\w-]+)/g)].some((m) => MAPPED.has(m[1])));
      if (!mapped) continue;
      const paint = rule.body.split(";").map((d) => d.split(":")[0].trim().toLowerCase())
        .filter((prop) => PAINT.test(prop) && !/url\(/.test(rule.body));
      if (paint.length) offenders.push(`${file.slice(SRC.length + 1)}: ${rule.selector.slice(0, 80)} { ${paint.join(", ")} }`);
    }
    expect(offenders).toEqual([]);
  });

  it("no control is disabled by opacity alone", () => {
    const offenders: string[] = [];
    for (const file of [...files, join(SRC, "styles/controls.css")]) for (const rule of rules(readFileSync(file, "utf8"))) {
      if (!/:disabled|\[disabled\]|\[aria-disabled|\.disabled\b/.test(rule.selector)) continue;
      if (/(^|;)\s*opacity\s*:\s*0?\.\d/.test(rule.body)) offenders.push(`${file.slice(SRC.length + 1)}: ${rule.selector.slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the recipe file declares all eight states for the keys", () => {
    const css = readFileSync(join(SRC, "styles/controls.css"), "utf8");
    for (const hook of [":hover", ":focus-visible", ":active", '[aria-pressed="true"]', ":disabled", '[aria-busy="true"]', '[aria-invalid="true"]']) expect(css).toContain(hook);
  });
});

describe("the switch's off state is visible in dark (design review I4)", () => {
  const controls = readFileSync(join(SRC, "styles/controls.css"), "utf8");
  const tokens = readFileSync(join(SRC, "styles/tokens.css"), "utf8");
  it("the knob takes its own role colour; in dark it is lifted toward the text (≥ 3:1 on the well), the on state keeps the sheet", () => {
    expect(controls).toMatch(/\.check-row\.switch-row input::before, \.browser-switch > span, \.draw-switch-track::after \{[^}]*background-color: var\(--switch-knob, var\(--surface\)\)/);
    const dark = tokens.slice(tokens.indexOf("/* Dark: what derives differently on dark paper. */"));
    expect(dark.slice(0, dark.indexOf("}"))).toMatch(/--switch-knob: color-mix\(in oklab, var\(--text\) 72%, var\(--surface\)\);/);
    expect(controls).toMatch(/\.check-row\.switch-row input:checked::before[^{]*\{[^}]*background-color: var\(--surface\)/);
  });
});
