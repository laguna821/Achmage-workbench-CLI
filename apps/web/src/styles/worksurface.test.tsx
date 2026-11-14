// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Vitest empties CSS imports, so the sheets are read from disk and applied through jsdom's parser.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const SHEETS = [read("../vendor/hig-kit/kit.css"), read("../styles.css"), read("./foundation.css"), read("./hig-workspace.css"), read("./hig-shell.css"), read("./panes.css")];

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

/** The blur radius of each layer of a box-shadow value (0 for an edge). */
function blurs(shadow: string) {
  if (!shadow || shadow === "none") return [];
  return shadow.split(/,(?![^(]*\))/).map((layer) => {
    const lengths = layer.replace(/(rgba?|color|var)\([^)]*\)/g, "").match(/-?[\d.]+(px)?(?=\s|$)/g) ?? [];
    return parseFloat(lengths[2] ?? "0");
  });
}

/** Every box-shadow declared by a top-level rule that reaches `element`, with variables resolved. */
function shadowsOn(element: Element) {
  const root = getComputedStyle(document.documentElement);
  const found: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      let hit = false;
      try {
        hit = element.matches(rule.selectorText);
      } catch {
        continue;
      }
      const value = rule.style.getPropertyValue("box-shadow");
      if (hit && value) found.push(value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => root.getPropertyValue(name).trim()));
    }
  }
  return found;
}

// WebKitGTK without compositing repaints a blurred shadow whenever anything inside the box
// repaints: on the pane sheet that stalled every tab open by about 150ms.
describe("work surface sheet", () => {
  it("rests on the window with an edge that has no blur, in a pane and as the loading surface", () => {
    for (const style of SHEETS) document.head.append(Object.assign(document.createElement("style"), { textContent: style }));
    document.body.innerHTML = `<div class="app look-scope"><div class="body with-sidebar"><div class="panes recursive"><section class="pane look-scope focused"></section></div><main></main></div></div>`;
    const pane = document.querySelector(".pane")!;
    const ancestors = [pane, ...(function* () { for (let at = pane.parentElement; at; at = at.parentElement) yield at; })(), document.querySelector(".body > main")!];
    const declared = ancestors.flatMap(shadowsOn);
    expect(shadowsOn(pane).length).toBeGreaterThan(0);
    for (const shadow of declared) expect(blurs(shadow).every((blur) => blur === 0), shadow).toBe(true);
  });
});
