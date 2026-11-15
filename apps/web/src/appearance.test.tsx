import { describe, expect, it } from "vitest";
import { APPEARANCE_VERSION, DEFAULT_APPEARANCE, NEUTRAL_LOOK, onColor, readAppearance } from "./appearance.ts";

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
  it("keeps primary text readable on both theme blues and custom mid-tone colors", () => {
    expect(onColor("#005ac1")).toBe("#ffffff");
    expect(onColor("#0091ff")).toBe("#000000");
    expect(onColor("#5cb8ff")).toBe("#000000");
    expect(onColor("#777777")).toBe("#000000");
  });
  it("gives old default values today's defaults", () => {
    const read = readAppearance(storedBefore());
    for (const provider of ["claude", "codex"] as const) {
      for (const theme of ["light", "dark"] as const) {
        expect(read[provider][theme].glow).toBe("off");
        expect(read[provider][theme].radius).toBe(10);
      }
    }
    expect(read.claude.light.palette.accent).toBe(DEFAULT_APPEARANCE.claude.light.palette.accent);
    expect(read.codex.light.palette.text).toBe(DEFAULT_APPEARANCE.codex.light.palette.text);
    expect(read.codex.light.bubble).toBe("soft");
    expect(read.claude.dark.bubble).toBe("soft");
    expect(read.v).toBe(APPEARANCE_VERSION);
  });

  it("migrates installed v2 defaults while preserving custom fonts and colors", () => {
    const stored = { ...storedBefore(), v: 2 };
    stored.codex.light.palette.text = "#0e1726";
    stored.codex.light.glow = "off";
    stored.codex.light.radius = 12;
    stored.claude.dark.font = "custom:My Font";
    stored.claude.dark.palette.accent = "#ff00aa";
    const read = readAppearance(stored);
    expect(read.codex.light.font).toBe("pretendard");
    expect(read.codex.light.palette.accent).toBe("#005bac");
    expect(read.codex.light.palette.text).toBe(N1.light.text);
    expect(read.codex.light.frame).toBe(false);
    expect(read.claude.dark.font).toBe("custom:My Font");
    expect(read.claude.dark.palette.accent).toBe("#ff00aa");
    expect(readAppearance(read)).toEqual(read);
  });

  it("restores brand colors from saved v3 defaults without resetting custom reading choices", () => {
    const stored = {
      v: 3,
      codex: { mode: "follow", light: {
        font: "custom:Reading Font", fontSize: 19, lineHeight: 1.9,
        palette: { accent: "#1E6EF4", heading: "#000000", headingAlt: "#623a91", text: "#172332", bg: "#fffaf0" },
      } },
      claude: { mode: "dark", dark: {
        palette: { accent: "#5cb8ff", heading: "#ffffff", link: "#fa9bb4", surface: "#20242a" },
      } },
    };
    const read = readAppearance(stored);
    expect(read.codex.light.palette.accent).toBe("#005bac");
    expect(read.codex.light.palette.heading).toBe(N1.light.heading);
    expect(read.codex.light.palette.headingAlt).toBe("#623a91");
    expect(read.codex.light.palette.text).toBe("#172332");
    expect(read.codex.light.palette.bg).toBe("#fffaf0");
    expect(read.codex.light.font).toBe("custom:Reading Font");
    expect(read.codex.light.fontSize).toBe(19);
    expect(read.codex.light.lineHeight).toBe(1.9);
    expect(read.claude.mode).toBe("dark");
    expect(read.claude.dark.palette.accent).toBe(N1.dark.accent);
    expect(read.claude.dark.palette.heading).toBe(N1.dark.heading);
    expect(read.claude.dark.palette.link).toBe("#fa9bb4");
    expect(read.claude.dark.palette.surface).toBe("#20242a");
    expect(read.v).toBe(APPEARANCE_VERSION);
    expect(readAppearance(read)).toEqual(read);
  });

  it("does not mistake a deliberately customized v2 color for a v3 default", () => {
    const stored = { v: 2, codex: { light: { palette: { heading: "#000000", accent: "#1e6ef4" } } } };
    const read = readAppearance(stored);
    expect(read.codex.light.palette.heading).toBe("#000000");
    expect(read.codex.light.palette.accent).toBe("#1e6ef4");
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
    expect(NEUTRAL_LOOK.dark.palette.accent).toBe(DEFAULT_APPEARANCE.claude.dark.palette.accent);
    // N1 (coordinator's ruling 6): in light the frame and the work are both white, parted by hairlines; dark keeps a step.
    expect(NEUTRAL_LOOK.light.palette.bg).toBe("#ffffff");
    expect(NEUTRAL_LOOK.dark.palette.bg).not.toBe(DEFAULT_APPEARANCE.codex.dark.palette.bg);
  });

  // v4 shipped Apple system greys; v5 tints them navy. Only values equal to the v4 default move.
  const V4 = {
    light: { bg: "#ffffff", surface: "#ffffff", text: "#000000", muted: "#6c6c70", line: "#d1d1d6", codeBg: "#f2f2f7", codeText: "#000000", accent: "#005bac", heading: "#00102e" },
    dark: { bg: "#1c1c1e", surface: "#2c2c2e", text: "#ffffff", muted: "#aeaeb2", line: "#3a3a3c", codeBg: "#2c2c2e", codeText: "#ffffff", accent: "#7db2f0", heading: "#8cc4ff" },
  };
  // v8 (Hallmark N1, the owner's direction): the hex mirrors of styles/tokens.css today.
  const N1 = {
    light: { bg: "#ffffff", surface: "#ffffff", text: "#131b29", muted: "#585e68", line: "#e1e4e8", codeBg: "#f3f5f7", codeText: "#131b29", accent: "#005bac", heading: "#131b29" },
    dark: { bg: "#18191b", surface: "#1c1d20", text: "#e8e9ec", muted: "#a0a5ac", line: "#2b2d30", codeBg: "#202225", codeText: "#e8e9ec", accent: "#76afee", heading: "#e8e9ec" },
  };
  // v7 (Hallmark U1, Furrow): what a stored default from then looks like.
  const F7 = {
    light: { bg: "#fffdf8", surface: "#fffdf8", text: "#121a2b", muted: "#5a544d", line: "#d3cbbe", codeBg: "#f6f2ea", codeText: "#121a2b", accent: "#005bac", heading: "#121a2b" },
    dark: { bg: "#201c17", surface: "#26221c", text: "#ebe7e0", muted: "#ada79e", line: "#39352d", codeBg: "#2d2821", codeText: "#ebe7e0", accent: "#76afee", heading: "#ebe7e0" },
  };
  const V5 = {
    light: { bg: "#ffffff", surface: "#ffffff", text: "#151b27", muted: "#566173", line: "#dce1e8", codeBg: "#f1f4f8", codeText: "#151b27", accent: "#005bac", heading: "#00102e" },
    dark: { bg: "#131820", surface: "#1b222c", text: "#e8ecf2", muted: "#a3adba", line: "#2c3541", codeBg: "#1b222c", codeText: "#e8ecf2", accent: "#7db2f0", heading: "#8cc4ff" },
  };

  // v6 keeps v5's surfaces and draws dark headings in ink.
  const V6 = { light: V5.light, dark: { ...V5.dark, heading: V5.dark.text } };

  it("defines the N1 white work surface and navy ink (tokens.css mirrors), the same for both engines", () => {
    for (const provider of ["claude", "codex"] as const) {
      for (const theme of ["light", "dark"] as const) {
        expect(DEFAULT_APPEARANCE[provider][theme].palette).toMatchObject(N1[theme]);
        expect(DEFAULT_APPEARANCE[provider][theme].radius).toBe(10);
      }
    }
    expect(DEFAULT_APPEARANCE.claude).toEqual(DEFAULT_APPEARANCE.codex);
  });

  // v7 (Hallmark U1): what is still at the v6 default takes the Furrow value; what the user chose stays.
  it("moves stored v6 defaults to today's and keeps the user's own colours and radius", () => {
    const stored = { v: 6,
      claude: { mode: "follow", light: { radius: 12, palette: { ...V6.light, accent: "#123456" } }, dark: { radius: 8, palette: { ...V6.dark } } },
      codex: { mode: "follow", light: { palette: { ...V6.light, bg: "#fffaf0" } } },
    };
    const read = readAppearance(stored);
    expect(read.claude.light.palette).toMatchObject({ ...N1.light, accent: "#123456" });
    expect(read.claude.light.radius).toBe(10);
    expect(read.claude.dark.palette).toMatchObject(N1.dark);
    expect(read.claude.dark.radius).toBe(8);
    expect(read.codex.light.palette.bg).toBe("#fffaf0");
    expect(read.codex.light.palette.text).toBe(N1.light.text);
    expect(read.v).toBe(APPEARANCE_VERSION);
    expect(readAppearance(read)).toEqual(read);
  });

  // v8 (Hallmark N1): a colour still at the v7 Furrow default takes the white and grey; the user's own stays.
  it("moves stored v7 (Furrow) defaults to the N1 palette and keeps the user's own colours", () => {
    const stored = { v: 7,
      claude: { mode: "follow", light: { radius: 10, palette: { ...F7.light, accent: "#123456" } }, dark: { palette: { ...F7.dark, line: "#445566" } } },
      codex: { mode: "dark", dark: { palette: { ...F7.dark } } },
    };
    const read = readAppearance(stored);
    expect(read.claude.light.palette).toMatchObject({ ...N1.light, accent: "#123456" });
    expect(read.claude.dark.palette).toMatchObject({ ...N1.dark, line: "#445566" });
    expect(read.codex.dark.palette).toMatchObject(N1.dark);
    expect(read.codex.mode).toBe("dark");
    expect(read.v).toBe(APPEARANCE_VERSION);
    expect(readAppearance(read)).toEqual(read);
  });

  it("moves stored v4 defaults to today's in both themes", () => {
    const stored = { v: 4, claude: { mode: "follow", light: { palette: { ...V4.light } }, dark: { palette: { ...V4.dark } } }, codex: { mode: "dark", dark: { palette: { ...V4.dark } } } };
    const read = readAppearance(stored);
    expect(read.claude.light.palette).toMatchObject(N1.light);
    expect(read.claude.dark.palette).toMatchObject(N1.dark);
    expect(read.codex.dark.palette).toMatchObject(N1.dark);
    expect(read.codex.mode).toBe("dark");
    expect(read.v).toBe(APPEARANCE_VERSION);
    expect(readAppearance(read)).toEqual(read);
  });

  it("keeps v4 colors, fonts and sizes the user changed, and moves only the untouched ones", () => {
    const stored = { v: 4, codex: { mode: "follow",
      light: { font: "custom:Reading Font", fontSize: 19, lineHeight: 1.9, fontWeight: 500, palette: { ...V4.light, text: "#222222", bg: "#fffaf0" } },
      dark: { palette: { ...V4.dark, line: "#445566", codeBg: "#000000" } },
    } };
    const read = readAppearance(stored);
    expect(read.codex.light.palette.text).toBe("#222222");
    expect(read.codex.light.palette.bg).toBe("#fffaf0");
    expect(read.codex.light.palette.muted).toBe(N1.light.muted);
    expect(read.codex.light.palette.line).toBe(N1.light.line);
    expect(read.codex.light.palette.codeText).toBe(N1.light.codeText);
    expect(read.codex.light).toMatchObject({ font: "custom:Reading Font", fontSize: 19, lineHeight: 1.9, fontWeight: 500 });
    expect(read.codex.dark.palette.line).toBe("#445566");
    expect(read.codex.dark.palette.codeBg).toBe("#000000");
    expect(read.codex.dark.palette.bg).toBe(N1.dark.bg);
    expect(read.codex.dark.palette.text).toBe(N1.dark.text);
  });

  it("matches v4 defaults regardless of letter case", () => {
    const read = readAppearance({ v: 4, claude: { light: { palette: { text: "#000000", line: "#D1D1D6" } }, dark: { palette: { bg: "#1C1C1E" } } } });
    expect(read.claude.light.palette.line).toBe(N1.light.line);
    expect(read.claude.dark.palette.bg).toBe(N1.dark.bg);
  });

  it("does not treat a v3-era or older custom black as a v4 default", () => {
    const read = readAppearance({ v: 2, codex: { light: { palette: { text: "#000000" } } } });
    expect(read.codex.light.palette.text).toBe("#000000");
  });

  it("reads v5 looks as stored", () => {
    const read = readAppearance({ v: 5, codex: { light: { palette: { text: "#000000", line: "#d1d1d6" } } } });
    expect(read.codex.light.palette.text).toBe("#000000");
    expect(read.codex.light.palette.line).toBe("#d1d1d6");
  });

  // v6: dark headings are ink, as light ones are, not link blue. Only the untouched v5 default moves.
  it("draws dark headings in ink, and moves a stored v5 dark default heading to it", () => {
    expect(APPEARANCE_VERSION).toBe(8);
    for (const provider of ["claude", "codex"] as const) expect(DEFAULT_APPEARANCE[provider].dark.palette.heading).toBe(DEFAULT_APPEARANCE[provider].dark.palette.text);
    const read = readAppearance({ v: 5, claude: { dark: { palette: { ...V5.dark } } }, codex: { dark: { palette: { ...V5.dark, heading: "#ff9fbe" } } } });
    expect(read.claude.dark.palette.heading).toBe(N1.dark.text);
    expect(read.codex.dark.palette.heading).toBe("#ff9fbe");
    expect(read.v).toBe(APPEARANCE_VERSION);
    expect(readAppearance(read)).toEqual(read);
  });
  it("draws dark small headings in ink too, and moves a stored v5 dark default to it", () => {
    for (const provider of ["claude", "codex"] as const) expect(DEFAULT_APPEARANCE[provider].dark.palette.headingAlt).toBe(DEFAULT_APPEARANCE[provider].dark.palette.text);
    const read = readAppearance({ v: 5, claude: { dark: { palette: { ...V5.dark, headingAlt: "#6fd3cf" } } }, codex: { dark: { palette: { ...V5.dark, headingAlt: "#ffcc00" } } } });
    expect(read.claude.dark.palette.headingAlt).toBe(N1.dark.text);
    expect(read.codex.dark.palette.headingAlt).toBe("#ffcc00");
  });
});
