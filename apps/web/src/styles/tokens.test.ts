// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_APPEARANCE, NEUTRAL_LOOK, type Palette } from "../appearance.ts";

// Hallmark U1: styles/tokens.css is the one source of colour, type, radius, elevation and motion.
// The default looks (appearance.ts) and the office chrome bridge carry sRGB hex mirrors of it,
// because a look is edited in colour fields and the editor runs on another origin.

// Vitest runs from the repository root (as the other style tests read their sheets).
const src = resolve("apps/web/src");
const TOKENS = readFileSync(join(src, "styles/tokens.css"), "utf8");
afterEach(() => { document.documentElement.removeAttribute("data-theme"); document.head.innerHTML = ""; });

/** Custom properties the document root ends up with from tokens.css, var() resolved. */
function rootTokens(theme: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", theme);
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
  const resolve = (value: string, depth = 0): string => depth > 8 ? value : value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(raw.get(name) ?? `var(${name})`, depth + 1));
  return (name: string) => resolve(raw.get(name) ?? "");
}

/** sRGB hex of an `oklch(L% C H)` value. */
function hexOf(value: string) {
  const m = /^oklch\(\s*([\d.]+)%\s*([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  const L = Number(m[1]) / 100, h = Number(m[3]) * Math.PI / 180, a = Number(m[2]) * Math.cos(h), b = Number(m[2]) * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return "#" + [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s]
    .map((c) => { c = Math.min(1, Math.max(0, c)); return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255).toString(16).padStart(2, "0"); }).join("");
}

// Which token each field of the default look mirrors.
const LOOK_TOKENS: Record<keyof Palette, string> = {
  bg: "--color-paper-2", surface: "--color-field", text: "--color-ink", muted: "--color-muted", line: "--color-rule",
  accent: "--color-accent", motion: "--color-teal", heading: "--color-ink", headingAlt: "--color-ink", strong: "--color-ink",
  link: "--color-accent", codeBg: "--color-paper-3", codeText: "--color-ink",
};

describe("one source of tokens", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`the default look and the desk's look are the hex mirrors of tokens.css (${theme})`, () => {
      const token = rootTokens(theme);
      for (const provider of ["claude", "codex"] as const) {
        const palette = DEFAULT_APPEARANCE[provider][theme].palette;
        for (const [field, name] of Object.entries(LOOK_TOKENS)) expect([theme, field, palette[field as keyof Palette]]).toEqual([theme, field, hexOf(token(name))]);
      }
      expect(NEUTRAL_LOOK[theme].palette.bg).toBe(hexOf(token("--color-paper")));
    });
  }

  it("keeps Achmage blue exact in light: #005bac", () => {
    expect(hexOf(rootTokens("light")("--color-accent"))).toBe("#005bac");
  });

  // Floor 1: no colour and no font family written into a rule; every size on the seven steps.
  const sheets = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sheets(path) : name.endsWith(".css") && name !== "tokens.css" ? [path] : [];
  });
  const declarations = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\([^)]*\)/g, "url()")
    .split(/[;{}]/).map((part) => part.trim()).filter((part) => /^[a-z-]+\s*:/.test(part) && !part.startsWith("--"));

  it("writes no colour literal into a rule outside tokens.css", () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(\s*\d|:\s*(?:white|black)\b|[\s,(](?:white|black)\s*[,)]/i;
    const found = sheets(src).flatMap((path) => declarations(path).filter((part) => !/^white-space|^font-variant/.test(part) && literal.test(part)).map((part) => `${path.slice(src.length)}: ${part}`));
    expect(found).toEqual([]);
  });

  it("names every face through a token", () => {
    const found = sheets(src).flatMap((path) => declarations(path).filter((part) => /^font-family\s*:/.test(part) && !/^font-family\s*:\s*(?:var\(|inherit)/.test(part)).map((part) => `${path.slice(src.length)}: ${part}`));
    expect(found).toEqual([]);
  });

  it("sets every font size on the scale (a token, or relative to the reading size)", () => {
    const found = sheets(src).flatMap((path) => declarations(path)
      // var() fallbacks aside; the root's own 16px (base.css, foundation.css) is the rem, not a step.
      .map((part) => part.replace(/var\([^()]*\)/g, "var()"))
      .filter((part) => /^font-size\s*:/.test(part) && /\d(?:px|rem)\b/.test(part) && !/^font-size\s*:\s*(?:max|clamp)\(/.test(part))
      .filter((part) => !(part === "font-size: 16px" && /\/(?:base|foundation)\.css$/.test(path)))
      .map((part) => `${path.slice(src.length)}: ${part}`));
    expect(found).toEqual([]);
  });

  it("never animates width, height, top or left, and never transitions all", () => {
    const found = sheets(src).flatMap((path) => declarations(path)
      .filter((part) => /^transition(?:-property)?\s*:/.test(part) && /(?:^|[\s,:])(?:all|width|height|top|left)(?:\s|,|$)/.test(part))
      .map((part) => `${path.slice(src.length)}: ${part}`));
    expect(found).toEqual([]);
  });
});
