// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Skin 2 fix 1, design review finding 1: tokens.css set `--chrome-accent: var(--accent)` for every look
// scope and hig-shell.css set `.sidebar { --accent: var(--chrome-accent) }`. The list column is
// `<aside class="sidebar look-scope nav-column">`, so on that one element the two referred to each other:
// both became invalid, and with them --accent-soft, --accent-line and --selected. Focus rings, drop
// marks, the rename field's edge and the new-answer dot in the list column were drawn in nothing.
// jsdom does not resolve custom properties, so this test runs the cascade itself: per element, the
// winning declaration of every custom property (importance, specificity, order), var() resolved
// against the same element, a cycle = invalid (as CSS Variables § 2.3), inherited when not declared.

const src = resolve("apps/web/src");
// main.tsx's order, then the column's own sheet.
const SHEETS = ["styles/tokens.css", "styles/base.css", "styles.css", "styles/foundation.css", "styles/hig-shell.css", "styles/hig-entry.css",
  "styles/hig-workspace.css", "styles/hig-chat.css", "styles/motion.css", "styles/controls.css", "styles/navigator.css"];

type Decl = { value: string; important: boolean; spec: number; order: number };

function specificity(selector: string): number {
  const s = selector.replace(/:(?:is|where|not|has)\((?:[^()]|\([^()]*\))*\)/g, (m) => m.startsWith(":where") ? "" : " .x");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (s.replace(/\[[^\]]*\]/g, "").match(/(?:^|[\s>+~(])[a-z][\w-]*|::[\w-]+/gi) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

function styleRules(): CSSStyleRule[] {
  const out: CSSStyleRule[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if ("selectorText" in rule) out.push(rule as CSSStyleRule);
      // @media / @supports / @container blocks describe other conditions (forced colours, the phone): not walked.
    }
  };
  for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
  return out;
}

/** The computed custom properties of `el` (resolved strings; "" = invalid at computed-value time). */
function customProps(el: Element, rules: CSSStyleRule[], cache = new Map<Element, Map<string, string>>()): Map<string, string> {
  const hit = cache.get(el);
  if (hit) return hit;
  const inherited = el.parentElement ? customProps(el.parentElement, rules, cache) : new Map<string, string>();
  const declared = new Map<string, Decl>();
  let order = 0;
  const offer = (name: string, decl: Decl) => {
    const was = declared.get(name);
    if (!was || Number(decl.important) - Number(was.important) > 0 || (decl.important === was.important && (decl.spec > was.spec || (decl.spec === was.spec && decl.order > was.order)))) declared.set(name, decl);
  };
  for (const rule of rules) {
    let spec = -1;
    for (const part of rule.selectorText.split(/,(?![^()]*\))/)) {
      let matches = false;
      try { matches = el.matches(part.trim()); } catch { /* jsdom cannot read it */ }
      if (matches) spec = Math.max(spec, specificity(part.trim()));
    }
    order++;
    if (spec < 0) continue;
    for (let i = 0; i < rule.style.length; i++) {
      const name = rule.style[i]!;
      if (name.startsWith("--")) offer(name, { value: rule.style.getPropertyValue(name).trim(), important: rule.style.getPropertyPriority(name) === "important", spec, order });
    }
  }
  const inline = (el as HTMLElement).style;
  for (let i = 0; inline && i < inline.length; i++) {
    const name = inline[i]!;
    if (name.startsWith("--")) offer(name, { value: inline.getPropertyValue(name).trim(), important: false, spec: 1_000_000, order: ++order });
  }

  const computed = new Map(inherited);
  const resolving = new Set<string>();
  const done = new Map<string, string>();
  const get = (name: string): string | undefined => {
    if (!declared.has(name)) return inherited.get(name);
    if (done.has(name)) return done.get(name);
    if (resolving.has(name)) return ""; // a cycle: invalid at computed-value time
    resolving.add(name);
    const value = substitute(declared.get(name)!.value);
    resolving.delete(name);
    // The cycle's members each end here with null (the inner one returned ""), so all are invalid.
    const final = value === null ? "" : value;
    done.set(name, final);
    return final;
  };
  /** Replaces every var() in `text`; null when one is invalid without a fallback. */
  const substitute = (text: string): string | null => {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const at = text.indexOf("var(", i);
      if (at < 0) { out += text.slice(i); break; }
      out += text.slice(i, at);
      let depth = 1, j = at + 4;
      while (j < text.length && depth > 0) { if (text[j] === "(") depth++; else if (text[j] === ")") depth--; j++; }
      const inner = text.slice(at + 4, j - 1);
      const comma = inner.indexOf(",");
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
      const value = get(name);
      if (value) out += value;
      else if (fallback !== null) { const f = substitute(fallback); if (f === null) return null; out += f; }
      else return null;
      i = j;
    }
    return out;
  };
  for (const name of declared.keys()) computed.set(name, get(name) ?? "");
  cache.set(el, computed);
  return computed;
}

function mount(theme: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", theme);
  for (const path of SHEETS) document.head.append(Object.assign(document.createElement("style"), { textContent: readFileSync(join(src, path), "utf8") }));
  // The app's root scope carries the look inline (appearance.ts lookStyle: the scope accent is the deep teal).
  document.body.innerHTML = `<div class="app look-scope with-rail" data-theme="${theme}" style="--accent: var(--color-teal-ink); --on-accent: var(--color-accent-ink)">
    <aside class="sidebar look-scope nav-column"><div class="nav-scroll"><div class="side-row current"><span class="side-row-icon"></span></div></div></aside>
    <header class="topbar"></header>
    <section class="pane look-scope focused"></section>
    <div class="context-menu look-scope"></div>
  </div>`;
  return styleRules();
}

afterEach(() => { document.documentElement.removeAttribute("data-theme"); document.head.innerHTML = ""; document.body.innerHTML = ""; });

describe("the list column's accent resolves (no custom-property cycle)", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`--accent, --accent-soft, --accent-line, --selected, --chrome-accent on .sidebar (${theme})`, () => {
      const rules = mount(theme);
      const props = customProps(document.querySelector(".sidebar")!, rules);
      const names = ["--accent", "--accent-soft", "--accent-line", "--selected", "--chrome-accent", "--focus", "--active-bg"];
      expect(Object.fromEntries(names.map((name) => [name, props.get(name) ? "ok" : "INVALID"]))).toEqual(Object.fromEntries(names.map((name) => [name, "ok"])));
      // The column's accent is the work's accent: the deep teal of this theme.
      expect(props.get("--accent")).toBe(customProps(document.querySelector(".pane")!, rules).get("--accent"));
    });

    it(`no custom property declared on a look scope is invalid by a cycle (${theme})`, () => {
      const rules = mount(theme);
      const invalid: string[] = [];
      for (const el of Array.from(document.querySelectorAll(".look-scope, .topbar"))) {
        for (const [name, value] of customProps(el, rules)) if (value === "") invalid.push(`${el.className.split(" ")[0]} ${name}`);
      }
      expect(invalid).toEqual([]);
    });
  }
});
