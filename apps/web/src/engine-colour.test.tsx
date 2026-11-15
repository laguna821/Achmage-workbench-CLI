// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AppearanceContext, DEFAULT_APPEARANCE, accentStyle, lookStyle, ownEngineColor, readAppearance, type AppearanceApi, type Appearance } from "./appearance.ts";
import { EngineMark } from "./components/EngineMark.tsx";

// Skin 2 (S9): an engine's colour is drawn only on the engine's own mark. A colour the person gave an
// engine earlier stays in storage exactly as it was; only where it applies changed.

const custom = (v: number): unknown => ({
  v,
  claude: { mode: "follow", light: { palette: { accent: "#be185d" } }, dark: { palette: { accent: "#f27aa4" } } },
  codex: { mode: "follow", light: { palette: { accent: "#0e8a6a" } } },
});

const api = (appearance: Appearance): AppearanceApi => ({
  appearance,
  appTheme: "light",
  lookOf: (provider) => appearance[provider].light,
  themeOf: () => "light",
  updateLook: () => undefined,
  setMode: () => undefined,
  resetLook: () => undefined,
  openMenu: () => undefined,
  openSettings: () => undefined,
});

describe("engine colour only on the engine's mark", () => {
  it.each([7, 8])("keeps a stored v%i engine colour as it was stored", (v) => {
    const read = readAppearance(custom(v));
    expect(read.claude.light.palette.accent).toBe("#be185d");
    expect(read.claude.dark.palette.accent).toBe("#f27aa4");
    expect(read.codex.light.palette.accent).toBe("#0e8a6a");
    // Read again (as it is saved back): still the person's values.
    expect(readAppearance(read)).toEqual(read);
  });

  it.each([7, 8])("never paints a scope's accent with a stored v%i engine colour", (v) => {
    const read = readAppearance(custom(v));
    const scope = lookStyle(read.claude.light) as Record<string, string>;
    expect(scope["--accent"]).toBe("var(--color-teal-ink)"); // the app's interaction accent (skin 2), never the engine colour
    expect(scope["--on-accent"]).toBe("var(--color-accent-ink)");
    expect(Object.values(scope)).not.toContain("#be185d");
  });

  it("gives what accentStyle wraps no accent: only a mark inside may read the engine's colour", () => {
    const read = readAppearance(custom(8));
    const style = accentStyle(read.codex.light) as Record<string, string>;
    expect(style["--accent"]).toBeUndefined();
    expect(style["--on-accent"]).toBeUndefined();
    expect(style["--engine-own"]).toBe("#0e8a6a");
    // A look that keeps the default has no colour of its own to hand on.
    expect(accentStyle(DEFAULT_APPEARANCE.claude.light)).toEqual({});
    expect(ownEngineColor(DEFAULT_APPEARANCE.codex.dark)).toBeNull();
  });

  it("draws the person's engine colour on the engine's mark, and the stylesheet's colour otherwise", () => {
    const { container, rerender } = render(
      <AppearanceContext.Provider value={api(readAppearance(custom(8)))}>
        <EngineMark provider="claude" />
        <EngineMark provider="codex" />
      </AppearanceContext.Provider>,
    );
    const [claude, codex] = Array.from(container.querySelectorAll<SVGElement>(".engine-mark"));
    expect(claude!.style.getPropertyValue("--engine-own")).toBe("#be185d");
    expect(codex!.style.getPropertyValue("--engine-own")).toBe("#0e8a6a");
    rerender(
      <AppearanceContext.Provider value={api(readAppearance(undefined))}>
        <EngineMark provider="claude" />
      </AppearanceContext.Provider>,
    );
    expect(container.querySelector<SVGElement>(".engine-mark")!.style.getPropertyValue("--engine-own")).toBe("");
  });

  it("draws a mark outside any appearance (tests, the phone) without failing", () => {
    const { container } = render(<EngineMark provider="codex" />);
    expect(container.querySelector(".engine-mark")).not.toBeNull();
  });
});
