// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Vitest empties CSS imports (even `?raw`), so the sheets are read from disk.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const kit = read("../vendor/hig-kit/kit.css");
const base = read("../styles.css");
const foundation = read("./foundation.css");
const chat = read("./hig-chat.css");
const note = read("./chat-note.css");
const motion = read("./motion.css");

// What the app's style sheets do to motion, read through the browser's own CSS parser (jsdom):
// the progress line while a turn runs, and reduced motion.

const SHEETS = [kit, base, foundation, chat, note, motion];

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

function load(sheets: string[]) {
  for (const text of sheets) {
    const style = document.createElement("style");
    style.textContent = text;
    document.head.append(style);
  }
}

/** The declarations of top-level rules that reach `element`'s `pseudo`, in source order. */
function pseudoRules(element: Element, pseudo: string) {
  const found: CSSStyleDeclaration[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const hit = rule.selectorText.split(",").map((part) => part.trim()).some((part) => {
        if (!part.endsWith(pseudo)) return false;
        try {
          return element.matches(part.slice(0, -pseudo.length));
        } catch {
          return false;
        }
      });
      if (hit) found.push(rule.style);
    }
  }
  return found;
}

function composer(glow: string, phase: string, provider = "codex") {
  document.body.innerHTML = `<section class="pane look-scope" data-glow="${glow}"><div class="composer hig-composer" data-provider="${provider}" data-phase="${phase}"></div></section>`;
  return document.querySelector(".composer")!;
}

/** The last value a property gets from `rules` (source order wins between equal selectors here). */
const last = (rules: CSSStyleDeclaration[], name: string) => rules.map((style) => style.getPropertyValue(name)).filter(Boolean).at(-1) ?? "";
const animated = (rules: CSSStyleDeclaration[], name: string) => rules.some((style) => new RegExp(name).test(style.getPropertyValue("animation") + style.getPropertyValue("animation-name")));

/** Rules inside `@media (prefers-reduced-motion: reduce)` that reach `element`'s `pseudo`. */
function reducedPseudoRules(element: Element, pseudo: string) {
  const found: CSSStyleDeclaration[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const media of Array.from(sheet.cssRules)) {
      if (!(media instanceof CSSMediaRule) || !/prefers-reduced-motion:\s*reduce/.test(media.conditionText)) continue;
      for (const rule of Array.from(media.cssRules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        const hit = rule.selectorText.split(",").map((part) => part.trim()).some((part) => {
          if (!part.endsWith(pseudo)) return false;
          try {
            return element.matches(part.slice(0, -pseudo.length));
          } catch {
            return false;
          }
        });
        if (hit) found.push(rule.style);
      }
    }
  }
  return found;
}

// One line, two states: the 2px engine line above the input, and while a turn runs a lighter
// pass of the same engine colour travelling along that very line.
describe("engine line above the input", () => {
  it.each(["claude", "codex"])("carries a moving pass of its own colour while a %s turn runs", (provider) => {
    load(SHEETS);
    const element = composer("off", "waiting", provider);
    const style = getComputedStyle(element);
    // jsdom computes no border from a shorthand with var(), so the line is read from the rules.
    const own = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules)).filter((rule): rule is CSSStyleRule => {
      if (!(rule instanceof CSSStyleRule)) return false;
      try {
        return element.matches(rule.selectorText);
      } catch {
        return false;
      }
    }).map((rule) => rule.style);
    expect(own.some((rule) => rule.getPropertyValue("border-top-width") === "2px" && rule.getPropertyValue("border-top-color") === "var(--engine-line)")).toBe(true);
    expect(style.getPropertyValue("--engine-line").trim()).toBe(provider === "claude" ? "var(--engine-claude)" : "var(--accent)");
    // The pass is the engine's colour lightened (toward the paper in light, the ink in dark): no second hue.
    expect(style.getPropertyValue("--engine-pass")).toMatch(/color-mix\(.*var\(--engine-line\).*var\(--line-highlight\)/);

    const rules = pseudoRules(element, "::before");
    expect(rules.some((rule) => !["", "none", "normal"].includes(rule.getPropertyValue("content")))).toBe(true);
    expect(animated(rules, "composer-working")).toBe(true);
    // Exactly on the line, not beside or across it.
    expect(last(rules, "top")).toBe("-2px");
    expect(last(rules, "height")).toBe("2px");
    const paint = last(rules, "background") + last(rules, "background-image");
    expect(paint).toMatch(/var\(--engine-pass\)/);
    expect(paint).not.toMatch(/--accent|--engine-claude|--motion/);
  });

  it("is a plain line when no turn runs", () => {
    load(SHEETS);
    const drawn = pseudoRules(composer("off", "idle"), "::before").filter((style) => !["", "none", "normal"].includes(style.getPropertyValue("content")));
    expect(drawn).toHaveLength(0);
  });

  it("with the light on, adds the orbit and keeps the pass on the line", () => {
    load(SHEETS);
    const element = composer("soft", "waiting", "claude");
    expect(animated(pseudoRules(element, "::after"), "composer-orbit")).toBe(true);
    const line = pseudoRules(element, "::before");
    expect(animated(line, "composer-working")).toBe(true);
    expect(last(line, "top")).toBe("-2px");
  });

  it("under reduced motion stands still yet still differs from idle", () => {
    load(SHEETS);
    const element = composer("soft", "waiting", "claude");
    const reduced = reducedPseudoRules(element, "::before");
    expect(reduced.some((rule) => rule.getPropertyValue("animation") === "none")).toBe(true);
    const paint = last(reduced, "background") + last(reduced, "background-image");
    expect(paint).toMatch(/repeating-linear-gradient\(.*var\(--engine-pass\)/);
    expect(reducedPseudoRules(element, "::after").some((rule) => rule.getPropertyValue("content") === "none")).toBe(true);
  });
});

describe("work summary while running", () => {
  it("shimmers the running step's text", () => {
    load(SHEETS);
    document.body.innerHTML = `<div class="transcript"><button class="work-summary"><span class="work-summary-text running">실행 상세</span></button></div>`;
    const running = document.querySelector(".work-summary-text")!;
    const animated = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSStyleRule => {
        if (!(rule instanceof CSSStyleRule)) return false;
        try {
          return running.matches(rule.selectorText);
        } catch {
          return false; // a selector jsdom does not know (e.g. ::-moz-range-track)
        }
      })
      .map((rule) => rule.style.getPropertyValue("animation") || rule.style.getPropertyValue("animation-name"))
      .filter((value) => value && value !== "none");
    expect(animated.at(-1) ?? "").toMatch(/work-shimmer/);
  });
});

const motionRules = () => {
  load([motion]);
  const out: CSSStyleRule[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) out.push(rule);
      else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
  return out;
};

describe("motion.css under reduced motion", () => {
  it("times every transition and animation with the shared duration tokens, never !important", () => {
    const timed = motionRules().filter((rule) => /transition|animation/.test(rule.style.cssText));
    expect(timed.length).toBeGreaterThan(0);
    for (const rule of timed) {
      for (const name of ["transition", "transition-duration", "animation", "animation-duration"]) {
        const value = rule.style.getPropertyValue(name);
        if (!value || value === "none") continue;
        expect(rule.style.getPropertyPriority(name), rule.selectorText).toBe("");
        // A duration is a token (or a multiple of one), never a literal.
        expect(value.replace(/var\(--(dur-fast|dur-base|dur-slow|ease-out|ease-in-out)\)/g, ""), `${rule.selectorText}: ${value}`).not.toMatch(/\d(ms|s)\b/);
      }
    }
  });

  it("is collapsed by the one global reduced-motion rule, which reaches pseudo-elements too", () => {
    load([foundation]);
    const reduce = Array.from(document.styleSheets[0]!.cssRules).find((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule && /prefers-reduced-motion:\s*reduce/.test(rule.conditionText));
    const all = Array.from(reduce!.cssRules).find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText.split(",").map((part) => part.trim()).includes("*"))!;
    expect(all.selectorText.replace(/\s/g, "").split(",").sort()).toEqual(["*", "*::after", "*::before"]);
    for (const name of ["transition-duration", "animation-duration"]) {
      expect(parseFloat(all.style.getPropertyValue(name))).toBeLessThanOrEqual(0.01);
      expect(all.style.getPropertyPriority(name)).toBe("important");
    }
    expect(all.style.getPropertyValue("animation-iteration-count")).toBe("1");
  });
});
