import type { SimForces } from "./graph-sim.ts";

// The graph's settings (filters, colours, display, forces), kept on this device under one
// versioned key. A value that is missing, of the wrong kind or out of range falls back to its
// default; unreadable JSON or another version gives the defaults.

export const GRAPH_SETTINGS_KEY = "workbench.graphSettings";
const VERSION = 1;

export type GraphSettings = {
  filter: { tags: boolean; relatedLines: boolean; tagLines: boolean; archived: boolean; orphans: boolean; search: string };
  /** `null`: the theme's colour. Projects take their stage's colour unless `projectBy` is "one". */
  color: { projectBy: "stage" | "one"; project: string | null; tag: string | null; related: string | null; tagLine: string | null; highlight: string | null };
  /** `textFade`: the zoom from which labels show (0 = always). */
  display: { nodeScale: number; relatedWidth: number; tagWidth: number; arrows: boolean; textFade: number; labelSize: number };
  force: { center: number; repel: number; relatedStrength: number; relatedDistance: number; tagStrength: number; tagDistance: number; pin: boolean };
  /** Which sections of the settings panel are open. */
  open: Record<GraphSection, boolean>;
};

export type GraphSection = "filter" | "color" | "display" | "force";

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  filter: { tags: true, relatedLines: true, tagLines: true, archived: false, orphans: true, search: "" },
  color: { projectBy: "stage", project: null, tag: null, related: null, tagLine: null, highlight: null },
  display: { nodeScale: 1, relatedWidth: 1.6, tagWidth: 1, arrows: false, textFade: 0.7, labelSize: 12 },
  force: { center: 0.05, repel: 160, relatedStrength: 0.7, relatedDistance: 130, tagStrength: 0.4, tagDistance: 80, pin: false },
  open: { filter: true, color: false, display: false, force: false },
};

/** Slider bounds: [min, max, step]. */
export const GRAPH_RANGES = {
  nodeScale: [0.5, 3, 0.1],
  relatedWidth: [0.5, 6, 0.1],
  tagWidth: [0.5, 6, 0.1],
  textFade: [0, 2, 0.05],
  labelSize: [10, 20, 1],
  center: [0, 0.3, 0.01],
  repel: [0, 600, 10],
  relatedStrength: [0, 1, 0.05],
  relatedDistance: [20, 400, 5],
  tagStrength: [0, 1, 0.05],
  tagDistance: [20, 400, 5],
} as const satisfies Record<string, readonly [number, number, number]>;

/** The colours offered next to "기본" (the same palette as the stages'); any #rrggbb can be typed. */
export const GRAPH_SWATCHES = ["#e5484d", "#f76b15", "#e2a400", "#30a46c", "#12a594", "#3e63dd", "#8e4ec6", "#d6409f", "#8b8d98"];

export const isHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

type Shape = { [K in keyof GraphSettings]: GraphSettings[K] };

/** Each known value checked against its default's kind and its range; anything else is the default. */
export function sanitizeGraphSettings(raw: unknown): GraphSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = structuredClone(DEFAULT_GRAPH_SETTINGS) as Shape;
  for (const section of Object.keys(out) as (keyof Shape)[]) {
    const given = source[section];
    if (!given || typeof given !== "object") continue;
    const target = out[section] as Record<string, unknown>;
    for (const [key, fallback] of Object.entries(target)) {
      const value = (given as Record<string, unknown>)[key];
      if (typeof fallback === "boolean") target[key] = typeof value === "boolean" ? value : fallback;
      else if (typeof fallback === "number") {
        const range = (GRAPH_RANGES as Record<string, readonly [number, number, number]>)[key];
        target[key] = typeof value === "number" && Number.isFinite(value) ? (range ? Math.min(range[1], Math.max(range[0], value)) : value) : fallback;
      } else if (section === "color") {
        if (key === "projectBy") target[key] = value === "one" ? "one" : "stage";
        else target[key] = isHex(value) ? value.toLowerCase() : null;
      } else if (typeof fallback === "string") target[key] = typeof value === "string" ? value.slice(0, 200) : fallback;
    }
  }
  return out;
}

export function readGraphSettings(storage: Pick<Storage, "getItem"> = localStorage): GraphSettings {
  try {
    const text = storage.getItem(GRAPH_SETTINGS_KEY);
    if (!text) return structuredClone(DEFAULT_GRAPH_SETTINGS);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { v?: unknown }).v !== VERSION) return structuredClone(DEFAULT_GRAPH_SETTINGS);
    return sanitizeGraphSettings(parsed);
  } catch {
    return structuredClone(DEFAULT_GRAPH_SETTINGS);
  }
}

export function writeGraphSettings(settings: GraphSettings, storage: Pick<Storage, "setItem"> = localStorage) {
  try {
    storage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify({ v: VERSION, ...settings }));
  } catch {
    // Not kept (storage full or off); the graph still uses them until the window closes.
  }
}

/** One section back to its defaults (which sections are open stays as it is). */
export function resetSection(settings: GraphSettings, section: GraphSection): GraphSettings {
  return { ...settings, [section]: structuredClone(DEFAULT_GRAPH_SETTINGS[section]) };
}

/** Every section back to its defaults. */
export function resetAll(settings: GraphSettings): GraphSettings {
  return { ...structuredClone(DEFAULT_GRAPH_SETTINGS), open: settings.open };
}

/** The forces the simulation runs with. */
export function forcesOf(settings: GraphSettings): SimForces {
  const { force } = settings;
  return {
    center: force.center,
    repel: force.repel,
    collide: 0.7,
    links: { related: { strength: force.relatedStrength, distance: force.relatedDistance }, tag: { strength: force.tagStrength, distance: force.tagDistance } },
  };
}
