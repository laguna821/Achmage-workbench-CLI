// 색 조합: the colour sets of Atlas File Manager a person can choose (설정 › 화면), as VALUES only. Each row
// is one of their themes (atlas-themes.json, `theirs`) with the values our roles are drawn from; nothing
// else of theirs is here. `scripts/atlas-sets.ts` turns the rows into the token blocks of tokens.css and the
// editors' mirrors (chrome.css) by one rule; "atlas" and "graphite" (the default pair) keep their approved,
// hand-written blocks. A "… Glass" twin of a set is the same colours behind a see-through window: our window
// is opaque, so it is the same choice and has no row. "Windows 어둡게" is their only dark Windows set
// ("Atlas Windows Glass"), drawn opaque. An 8-digit value keeps its alpha here; the generator lays it over
// the set's own ground.

export type SetMode = "light" | "dark";
export type AtlasSource = {
  /** background */ background: string; /** list.background */ list: string; /** list.head.background */ listHead: string;
  /** muted.background */ well: string; /** foreground */ ink: string; /** muted.foreground */ mutedInk: string;
  /** border */ border: string; /** input.border */ inputBorder: string; /** accent.background */ accent: string;
  /** primary.active.background */ accentDeep: string; /** link.hover */ linkBright: string;
  /** sidebar.background */ sidebar: string; /** sidebar.foreground */ sidebarInk: string;
  /** danger.background */ danger: string; /** success.background */ success: string; /** warning.background */ warning: string;
  /** overlay */ overlay: string;
};
export type AtlasSet = { id: string; name: string; theirs: string; mode: SetMode; from: AtlasSource };

export const ATLAS_SETS: readonly AtlasSet[] = [
  { id: "atlas", name: "Atlas Light", theirs: "Atlas Light", mode: "light",
    from: { background: "#ffffff", list: "#ffffff", listHead: "#f9f9fb", well: "#f2f2f7", ink: "#1d1d1f", mutedInk: "#626268", border: "#e5e5ea", inputBorder: "#d1d1d6", accent: "#007aff", accentDeep: "#0064d2", linkBright: "#0a84ff", sidebar: "#f2f2f7", sidebarInk: "#1d1d1f", danger: "#ff3b30", success: "#34c759", warning: "#ff9f0a", overlay: "#00000026" } },
  { id: "windows", name: "Windows", theirs: "Atlas Windows", mode: "light",
    from: { background: "#f7f9fd", list: "#ffffff", listHead: "#f8fafc", well: "#eef3fb", ink: "#1b1f2a", mutedInk: "#576174", border: "#dbe3f1", inputBorder: "#d7dfec", accent: "#2563eb", accentDeep: "#1d4ed8", linkBright: "#3b82f6", sidebar: "#f3f7fd", sidebarInk: "#1b1f2a", danger: "#dc2626", success: "#16a34a", warning: "#f59e0b", overlay: "#1b1f2a26" } },
  { id: "rose", name: "Rosé", theirs: "Atlas Rosé", mode: "light",
    from: { background: "#fdf7f8", list: "#fdf7f8", listHead: "#f8eef1", well: "#f5eaed", ink: "#2e1f24", mutedInk: "#755963", border: "#ecd9de", inputBorder: "#e1cdd3", accent: "#d4637b", accentDeep: "#c04f67", linkBright: "#dc7a8f", sidebar: "#f6ecefcc", sidebarInk: "#2e1f24", danger: "#e5484d", success: "#46a758", warning: "#e5984e", overlay: "#2e1f2420" } },
  { id: "graphite", name: "Graphite", theirs: "Atlas Graphite", mode: "dark",
    from: { background: "#1c1c1e", list: "#1c1c1e", listHead: "#242426", well: "#2c2c2e", ink: "#f5f5f7", mutedInk: "#98989d", border: "#38383a", inputBorder: "#48484a", accent: "#0a84ff", accentDeep: "#0064d2", linkBright: "#409cff", sidebar: "#1c1c1ee6", sidebarInk: "#f5f5f7", danger: "#ff453a", success: "#30d158", warning: "#ffd60a", overlay: "#00000059" } },
  { id: "midnight", name: "Midnight", theirs: "Atlas Midnight", mode: "dark",
    from: { background: "#000000", list: "#000000", listHead: "#0a0a0a", well: "#1c1c1e", ink: "#e5e5ea", mutedInk: "#636366", border: "#1c1c1e", inputBorder: "#2c2c2e", accent: "#0a84ff", accentDeep: "#0064d2", linkBright: "#409cff", sidebar: "#000000", sidebarInk: "#e5e5ea", danger: "#ff453a", success: "#30d158", warning: "#ffd60a", overlay: "#00000080" } },
  { id: "noir", name: "Noir", theirs: "Atlas Noir", mode: "dark",
    from: { background: "#161618", list: "#161618", listHead: "#1a1a1c", well: "#1e1e22", ink: "#cdcdcf", mutedInk: "#6b6b70", border: "#2a2a2e", inputBorder: "#38383e", accent: "#8b8bf5", accentDeep: "#7676e0", linkBright: "#b5b5fa", sidebar: "#121214e6", sidebarInk: "#cdcdcf", danger: "#f5555d", success: "#4cc764", warning: "#f0b442", overlay: "#00000066" } },
  { id: "ember", name: "Ember", theirs: "Atlas Ember", mode: "dark",
    from: { background: "#000000d9", list: "#0b0b0b", listHead: "#0b0b0b", well: "#141414", ink: "#e8e8e8", mutedInk: "#7c7c7c", border: "#1f1f1f", inputBorder: "#2a2a2a", accent: "#e5481e", accentDeep: "#c93c15", linkBright: "#ff8358", sidebar: "#00000000", sidebarInk: "#e8e8e8", danger: "#f5555d", success: "#4cc764", warning: "#f0b442", overlay: "#00000099" } },
  { id: "dracula", name: "Dracula", theirs: "Atlas Dracula", mode: "dark",
    from: { background: "#282a36", list: "#282a36", listHead: "#2c2e3b", well: "#44475a", ink: "#f8f8f2", mutedInk: "#6272a4", border: "#44475a", inputBorder: "#44475a", accent: "#bd93f9", accentDeep: "#bd93f9", linkBright: "#bd93f9", sidebar: "#282a36", sidebarInk: "#f8f8f2", danger: "#ff5555", success: "#50fa7b", warning: "#ffb86c", overlay: "#00000020" } },
  { id: "nord", name: "Nord", theirs: "Atlas Nord", mode: "dark",
    from: { background: "#2e3440", list: "#2e3440", listHead: "#343b48", well: "#3b4252", ink: "#d8dee9", mutedInk: "#4c566a", border: "#3b4252", inputBorder: "#3b4252", accent: "#88c0d0", accentDeep: "#88c0d0", linkBright: "#88c0d0", sidebar: "#2e3440", sidebarInk: "#d8dee9", danger: "#bf616a", success: "#a3be8c", warning: "#ebcb8b", overlay: "#00000020" } },
  { id: "rose-pine", name: "Rosé Pine", theirs: "Atlas Rosé Pine", mode: "dark",
    from: { background: "#191724", list: "#191724", listHead: "#1d1a29", well: "#26233a", ink: "#e0def4", mutedInk: "#908caa", border: "#26233a", inputBorder: "#26233a", accent: "#ebbcba", accentDeep: "#ebbcba", linkBright: "#ebbcba", sidebar: "#191724", sidebarInk: "#e0def4", danger: "#eb6f92", success: "#9ccfd8", warning: "#f6c177", overlay: "#00000020" } },
  { id: "windows-dark", name: "Windows 어둡게", theirs: "Atlas Windows Glass", mode: "dark",
    from: { background: "#10111459", list: "#101114f5", listHead: "#181a20fa", well: "#18191df2", ink: "#f5f5f7", mutedInk: "#c7c7cc", border: "#000000cc", inputBorder: "#48484a80", accent: "#0a84ff", accentDeep: "#0064d2", linkBright: "#409cff", sidebar: "#101114f2", sidebarInk: "#f5f5f7", danger: "#ff453a", success: "#30d158", warning: "#ffd60a", overlay: "#00000059" } },
];

/** The default pair (their default light and dark): the hand-written blocks of tokens.css. */
export const DEFAULT_SET = { light: "atlas", dark: "graphite" } as const;
/** Ours: both modes, no block (the base tokens). */
export const WORKBENCH_SET = "workbench";
