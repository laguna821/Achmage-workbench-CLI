import { describe, expect, it } from "vitest";
import { APPEARANCE_VERSION, DEFAULT_APPEARANCE, NEUTRAL_LOOK, readAppearance } from "./appearance.ts";

// Looks stored before the design pass carry the old defaults wholesale (saving one change saves
// every look). Those values take today's defaults; what the user changed stays; looks stored
// after the pass are read as they are.

/** A look as the app stored it before the design pass, all values the defaults of the time. */
const oldLook = (palette: Record<string, string>, rest: Record<string, unknown> = {}) => ({
  palette,
  font: "sametone",
  fontSize: 17,
  lineHeight: 1.75,
  fontWeight: 400,
  bubble: "filled",
  borderWidth: 1,
  radius: 16,
  glow: "soft",
  frame: true,
  ...rest,
});

const storedBefore = () => ({
  claude: {
    mode: "follow",
    light: oldLook({ bg: "#faf9f5", accent: "#c96442", text: "#1f1e1b" }, { bubble: "soft", radius: 20 }),
    dark: oldLook({ bg: "#08090a", accent: "#f27aa4" }, { bubble: "rail" }),
  },
  codex: {
    mode: "follow",
    light: oldLook({ bg: "#ffffff", accent: "#005bac", text: "#000000" }, { fontSize: 16, lineHeight: 1.7 }),
    dark: oldLook({ bg: "#070b14", accent: "#5aa9f0" }, { fontSize: 16, lineHeight: 1.7, bubble: "rail", radius: 12 }),
  },
});

describe("readAppearance", () => {
  it("gives old default values today's defaults", () => {
    const read = readAppearance(storedBefore());
    for (const provider of ["claude", "codex"] as const) {
      for (const theme of ["light", "dark"] as const) {
        expect(read[provider][theme].glow).toBe("off");
        expect(read[provider][theme].radius).toBe(12);
      }
    }
    expect(read.claude.light.palette.accent).toBe(DEFAULT_APPEARANCE.claude.light.palette.accent);
    expect(read.codex.light.palette.text).toBe("#0e1726");
    expect(read.codex.light.bubble).toBe("soft");
    expect(read.claude.dark.bubble).toBe("rail");
    expect(read.v).toBe(APPEARANCE_VERSION);
  });

  it("keeps what the user changed", () => {
    const stored = storedBefore();
    stored.codex.light.glow = "neon";
    stored.codex.light.radius = 6;
    stored.claude.light.palette.accent = "#123456";
    stored.claude.dark.palette.accent = "#ff00aa";
    stored.claude.dark.bubble = "filled";
    const read = readAppearance(stored);
    expect(read.codex.light.glow).toBe("neon");
    expect(read.codex.light.radius).toBe(6);
    expect(read.claude.light.palette.accent).toBe("#123456");
    expect(read.claude.dark.palette.accent).toBe("#ff00aa");
    expect(read.claude.dark.bubble).toBe("filled");
  });

  it("reads looks stored after the design pass as they are, so 'soft' can be chosen again", () => {
    const stored = { ...storedBefore(), v: APPEARANCE_VERSION };
    const read = readAppearance(stored);
    expect(read.codex.light.glow).toBe("soft");
    expect(read.claude.light.radius).toBe(20);
    expect(read.codex.light.palette.text).toBe("#000000");
  });

  it("starts from the new defaults with nothing stored, and keeps the frame apart from the looks", () => {
    const read = readAppearance(undefined);
    expect(read.codex.light).toEqual(DEFAULT_APPEARANCE.codex.light);
    expect(read.claude.dark.glow).toBe("off");
    // The neutral frame is not the Claude dark look: no pink in the sidebar or menus.
    expect(NEUTRAL_LOOK.dark.palette.accent).not.toBe(DEFAULT_APPEARANCE.claude.dark.palette.accent);
    expect(NEUTRAL_LOOK.light.palette.bg).not.toBe(DEFAULT_APPEARANCE.codex.light.palette.bg);
  });
});
