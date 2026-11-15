// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_APPEARANCE, NEUTRAL_LOOK, lookStyle, readAppearance } from "../appearance.ts";
import { readPalette, setRootPalette } from "../theme.ts";

// 색 조합 Atlas (atlas-look): Atlas File Manager's colour values on the app's own roles, light ("Atlas Light")
// and dark ("Atlas Graphite"); colour values only (no radius, no size, no space); every text pair 4.5:1; Atlas is
// the default (a stored record without the field is Atlas), Workbench stays a choice.

const TOKENS = readFileSync(join(resolve("apps/web/src"), "styles/tokens.css"), "utf8");
afterEach(() => { document.documentElement.removeAttribute("data-theme"); document.documentElement.removeAttribute("data-palette"); document.head.innerHTML = ""; localStorage.clear(); });

/** The declarations of the block whose selector list starts with `head`. */
function block(head: string) {
  const at = TOKENS.indexOf(`${head},`) >= 0 ? TOKENS.indexOf(`${head},`) : TOKENS.indexOf(`${head} {`);
  expect(at, head).toBeGreaterThan(-1);
  const body = TOKENS.slice(TOKENS.indexOf("{", at) + 1, TOKENS.indexOf("}", at));
  return new Map([...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}
const LIGHT = ':root[data-palette="atlas"]', DARK = ':root[data-palette="atlas"][data-theme="dark"]';

/** Root custom properties for a theme and combination, var() resolved (as tokens.test.ts reads them). */
function tokens(theme: "light" | "dark", palette: "workbench" | "atlas") {
  document.documentElement.setAttribute("data-theme", theme);
  if (palette === "atlas") document.documentElement.setAttribute("data-palette", "atlas");
  document.head.append(Object.assign(document.createElement("style"), { textContent: TOKENS }));
  const raw = new Map<string, string>();
  for (const sheet of Array.from(document.styleSheets)) for (const rule of Array.from(sheet.cssRules)) {
    if (!("selectorText" in rule)) continue;
    let matches = false;
    try { matches = document.documentElement.matches((rule as CSSStyleRule).selectorText); } catch { /* jsdom cannot read it */ }
    if (!matches) continue;
    const style = (rule as CSSStyleRule).style;
    for (let i = 0; i < style.length; i++) if (style[i].startsWith("--")) raw.set(style[i], style.getPropertyValue(style[i]).trim());
  }
  const resolveVar = (value: string, depth = 0): string => depth > 8 ? value : value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolveVar(raw.get(name) ?? `var(${name})`, depth + 1));
  return (name: string) => resolveVar(raw.get(name) ?? "");
}

// sRGB of `#rrggbb` or `color-mix(in oklab, <colour> p%, <colour>)` (what the Atlas block writes).
type Rgb = [number, number, number];
const lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toOklab = ([r, g, b]: Rgb) => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const fromOklab = ([L, A, B]: number[]): Rgb => {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(c => Math.min(1, Math.max(0, c))) as Rgb;
};
function linear(value: string): Rgb {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map(at => lin(parseInt(hex[1].slice(at, at + 2), 16) / 255)) as Rgb;
  const mix = /^color-mix\(in oklab,\s*(#[0-9a-f]{6})\s+(\d+)%,\s*(#[0-9a-f]{6})\)$/i.exec(v);
  if (!mix) throw new Error(`not an Atlas colour: ${v}`);
  const p = Number(mix[2]) / 100, a = toOklab(linear(mix[1])), b = toOklab(linear(mix[3]));
  return fromOklab(a.map((x, i) => x * p + b[i]! * (1 - p)));
}
const ratio = (fg: string, bg: string) => {
  const y = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const [hi, lo] = [y(linear(fg)), y(linear(bg))].sort((p, q) => q - p);
  return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
};

describe("색 조합 Atlas", () => {
  // The roles the brief names: work, list and top-bar surfaces, the well, the rail, hairlines and edges,
  // ink, muted ink, the accent (marks and words), the filled key, the selection wash, state colours.
  const ROLES = ["--color-paper", "--color-paper-2", "--color-paper-3", "--color-field", "--color-ink", "--color-ink-2", "--color-muted", "--color-faint",
    "--color-rule", "--color-edge", "--color-teal", "--color-teal-ink", "--color-attention", "--color-attention-ink", "--color-attention-text",
    "--color-attention-soft", "--color-done", "--color-done-soft", "--color-error", "--color-error-soft", "--color-scrim",
    "--color-rail", "--color-rail-ink", "--color-rail-muted", "--color-rail-hover", "--color-rail-current", "--color-rail-mark", "--color-rail-rule", "--color-rail-focus",
    "--key-primary", "--on-key-primary", "--color-current-soft", "--active-bg"];

  it("defines every role token in the Atlas block, light and dark alike", () => {
    const light = block(LIGHT), dark = block(DARK);
    expect(ROLES.filter(name => !light.has(name))).toEqual([]);
    expect(ROLES.filter(name => !dark.has(name))).toEqual([]);
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
  });

  it("takes Atlas's own values: Atlas Light and Atlas Graphite", () => {
    const light = block(LIGHT), dark = block(DARK);
    expect([light.get("--color-paper-2"), light.get("--color-rail"), light.get("--color-rule"), light.get("--color-ink"), light.get("--color-muted"), light.get("--color-teal")])
      .toEqual(["#ffffff", "#f2f2f7", "#e5e5ea", "#1d1d1f", "#626268", "#007aff"]);
    expect([dark.get("--color-paper-2"), dark.get("--color-rail"), dark.get("--color-rule"), dark.get("--color-ink"), dark.get("--color-muted"), dark.get("--color-teal"), dark.get("--color-teal-ink")])
      .toEqual(["#1c1c1e", "#2c2c2e", "#38383a", "#f5f5f7", "#98989d", "#0a84ff", "#409cff"]);
  });

  for (const theme of ["light", "dark"] as const) {
    it(`reads every text pair at 4.5:1 or more (${theme})`, () => {
      const t = tokens(theme, "atlas");
      const pairs: [string, string][] = [
        ["--color-ink", "--color-paper-2"], ["--color-ink", "--color-field"], ["--color-ink", "--color-paper-3"], ["--color-ink-2", "--color-paper-2"],
        ["--color-muted", "--color-paper-2"], ["--color-muted", "--color-field"], ["--color-muted", "--color-paper-3"],
        ["--color-teal-ink", "--color-paper-2"], ["--color-teal-ink", "--color-field"], ["--color-teal-ink", "--active-bg"], ["--color-muted", "--active-bg"],
        ["--on-key-primary", "--key-primary"], ["--color-attention-ink", "--color-attention"],
        ["--color-attention-text", "--color-paper-2"], ["--color-attention-text", "--color-attention-soft"],
        ["--color-done", "--color-paper-2"], ["--color-done", "--color-done-soft"],
        ["--color-error", "--color-paper-2"], ["--color-error", "--color-field"], ["--color-error", "--color-error-soft"],
        ["--color-rail-ink", "--color-rail"], ["--color-rail-muted", "--color-rail"], ["--color-rail-ink", "--color-rail-current"], ["--color-rail-ink", "--color-rail-hover"],
      ];
      const low = pairs.map(([fg, bg]) => [fg, bg, ratio(t(fg), t(bg))] as const).filter(([, , r]) => r < 4.5);
      expect(low).toEqual([]);
    });
  }

  it("keeps the edges of fields and keys at 3:1 (light and dark)", () => {
    for (const theme of ["light", "dark"] as const) {
      const t = tokens(theme, "atlas");
      expect(ratio(t("--color-edge"), t("--color-field"))).toBeGreaterThanOrEqual(3);
      document.head.innerHTML = "";
    }
  });

  it("leaves Workbench as it was: without the attribute no Atlas value applies", () => {
    for (const theme of ["light", "dark"] as const) {
      const t = tokens(theme, "workbench");
      expect(t("--color-rail")).not.toMatch(/#f2f2f7|#2c2c2e/);
      expect(t("--palette-look-light-ink")).toBe("");
      document.head.innerHTML = "";
    }
  });
});

describe("the stored choice", () => {
  it("reads a record without the field (or anything unknown) as Atlas, the default; only an explicit 'workbench' is Workbench", () => {
    expect([readPalette(undefined), readPalette(null), readPalette("Workbench"), readPalette(3), readPalette("atlas"), readPalette("workbench")])
      .toEqual(["atlas", "atlas", "atlas", "atlas", "atlas", "workbench"]);
  });

  it("puts the choice on <html> and takes it off for Workbench; the first paint remembers it", () => {
    setRootPalette("atlas");
    expect(document.documentElement.dataset.palette).toBe("atlas");
    expect(localStorage.getItem("workbench.firstPaintPalette")).toBe("atlas");
    setRootPalette("workbench");
    expect(document.documentElement.hasAttribute("data-palette")).toBe(false);
  });

  it("an old appearance record (no 색 조합 in it) reads exactly as before", () => {
    const old = { v: 8, claude: { mode: "follow", light: { fontSize: 18 } }, codex: { mode: "dark" } };
    const read = readAppearance(old);
    expect(read.claude.light.fontSize).toBe(18);
    expect(read.codex.mode).toBe("dark");
    expect(read.claude.light.palette).toEqual(DEFAULT_APPEARANCE.claude.light.palette);
  });

  it("a look colour at its default follows the combination (same hex as its fallback); one the person chose stays", () => {
    const light = lookStyle(DEFAULT_APPEARANCE.claude.light) as Record<string, string>;
    expect(light["--text"]).toBe(`var(--palette-look-light-ink, ${DEFAULT_APPEARANCE.claude.light.palette.text})`);
    expect(light["--bg"]).toBe("#ffffff");
    const dark = lookStyle(NEUTRAL_LOOK.dark) as Record<string, string>;
    expect(dark["--bg"]).toBe(`var(--palette-look-dark-paper, ${NEUTRAL_LOOK.dark.palette.bg})`);
    const own = lookStyle({ ...DEFAULT_APPEARANCE.claude.light, palette: { ...DEFAULT_APPEARANCE.claude.light.palette, text: "#222244" } }) as Record<string, string>;
    expect(own["--text"]).toBe("#222244");
  });
});
