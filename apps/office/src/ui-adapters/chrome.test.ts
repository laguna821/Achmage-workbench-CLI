// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { appTokens, CHROME_MIRRORS, chromeMirrors, srgbHex } from "./app-tokens.ts";
import { ATLAS_SETS } from "../../../web/src/styles/atlas-sets.ts";

const css = readFileSync("apps/office/src/ui-adapters/chrome.css", "utf8");

// The editors' chrome cannot read the app's custom properties (another origin): chrome.css copies them as hex.
// Every copy must be the app's token, light and dark, and no copy may exist without a token it follows.
const SETS: ["light" | "dark", string][] = [["light", "workbench"], ["dark", "workbench"], ...ATLAS_SETS.map(set => [set.mode, set.id] as ["light" | "dark", string])];

it("mirrors every app token the editors' chrome copies, light and dark, in Workbench and in every Atlas set, and copies nothing without a token", async () => {
  expect(SETS.length).toBe(13);
  for (const [theme, palette] of SETS) {
    const mirrors = chromeMirrors(css, theme, palette), app = await appTokens(theme, palette), at = `${palette} ${theme}`;
    expect([at, [...mirrors.keys()].filter(name => !(name in CHROME_MIRRORS))]).toEqual([at, []]);
    expect([at, Object.keys(CHROME_MIRRORS).filter(name => !mirrors.has(name))]).toEqual([at, []]);
    for (const [name, token] of Object.entries(CHROME_MIRRORS)) {
      expect(app.has(token), `${token} is not an app token`).toBe(true);
      expect([at, name, mirrors.get(name)]).toEqual([at, name, srgbHex(app.get(token)!)]);
    }
  }
});

it("keeps every colour of the chrome sheets on the mirrors: no hex outside chrome.css's root blocks (Workbench's two, one per Atlas set)", () => {
  const rest = css.replace(/__WB_ROOT__(?:\[data-wb-office-palette="[\w-]+"\])?(?:\[data-wb-office-theme="dark"\])? \{[^}]*\}/g, "");
  expect(rest.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  // The formats' own sheets (Hangul studio, Markdown ribbon) draw only with the mirrors as well.
  for (const sheet of ["hangul-studio.css", "markdown-ribbon.css"]) {
    const text = readFileSync(`apps/office/src/ui-adapters/${sheet}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect([sheet, text.match(/#[0-9a-f]{3,8}\b(?![^{}]*\{)/gi) ?? []]).toEqual([sheet, []]);
  }
});

// The one filled key of every editor is the app's navy key (skin 2), never the teal of focus and selection.
it("fills an editor's primary key with the app's navy key and its ink, not the focus teal", () => {
  const rule = (selector: RegExp) => css.split("}").find(block => selector.test(block)) ?? "";
  const primary = rule(/button\.primary, \.btn-primary/);
  expect(primary).toMatch(/background: var\(--wb-ui-key\) !important/);
  expect(primary).toMatch(/color: var\(--wb-ui-on-key\) !important/);
  expect(primary).not.toMatch(/--wb-ui-focus/);
  const chrome = rule(/--color-btn-primary:/);
  for (const name of ["--color-btn-primary", "--color-btn-primary-hover", "--color-ai-action", "--color-ai-action-hover"]) expect(chrome).toMatch(new RegExp(`${name}: var\\(--wb-ui-key\\);`));
});

it("Excel in a narrow window with its AI panel open: the panel lies over the grid, the grid keeps the second track (office-leftovers 4a: the absolutely placed panel left the grid in the 34px track — a blank sheet)", () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 1039px)"));
  expect(narrow).toMatch(/\.sheet-body:has\(> \.copilot:not\(\.collapsed\)\) > \.sheet-main \{[^}]*grid-column: 2/);
});
