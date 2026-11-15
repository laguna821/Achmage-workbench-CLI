import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const css = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const rule = (sheet: string, selector: string) => {
  const at = sheet.indexOf(`\n${selector} {`);
  return at < 0 ? "" : sheet.slice(at, sheet.indexOf("}", at));
};

test("the full-window reader lies over the navigation rail and under dialogs", () => {
  const tokens = css("tokens.css");
  const layer = (name: string) => Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(tokens)?.[1]);
  expect(rule(css("navigator.css"), ".nav-rail")).toContain("z-index: var(--z-sheet)");
  expect(rule(css("views.css"), ".reader")).toContain("z-index: calc(var(--z-sheet) + 1)");
  expect(layer("sheet") + 1).toBeLessThan(layer("modal"));
});
