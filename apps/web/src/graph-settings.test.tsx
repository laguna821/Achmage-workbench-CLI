import { describe, expect, it } from "vitest";
import { DEFAULT_GRAPH_SETTINGS, GRAPH_SETTINGS_KEY, forcesOf, readGraphSettings, resetAll, resetSection, sanitizeGraphSettings, writeGraphSettings } from "./graph-settings.ts";

// The graph's settings on this device: one versioned key, tolerant of anything stored there.

const storage = (text: string | null) => {
  const data = new Map<string, string>(text === null ? [] : [[GRAPH_SETTINGS_KEY, text]]);
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
};

describe("graph settings", () => {
  it("start from the defaults, and go back to them on unreadable JSON or another version", () => {
    expect(readGraphSettings(storage(null))).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(readGraphSettings(storage("{not json"))).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(readGraphSettings(storage("null"))).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(readGraphSettings(storage(JSON.stringify({ v: 99, display: { nodeScale: 2 } })))).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(readGraphSettings(storage(JSON.stringify({ display: { nodeScale: 2 } })))).toEqual(DEFAULT_GRAPH_SETTINGS);
  });

  it("keep what was saved, and survive a reload", () => {
    const place = storage(null);
    const changed = { ...DEFAULT_GRAPH_SETTINGS, color: { ...DEFAULT_GRAPH_SETTINGS.color, related: "#e5484d" }, force: { ...DEFAULT_GRAPH_SETTINGS.force, relatedDistance: 240, pin: true } };
    writeGraphSettings(changed, place);
    expect(JSON.parse(place.data.get(GRAPH_SETTINGS_KEY)!).v).toBe(1);
    expect(readGraphSettings(place)).toEqual(changed);
  });

  it("check each value: wrong kinds fall back, numbers stay in range, colours must be #rrggbb", () => {
    const read = sanitizeGraphSettings({
      v: 1,
      filter: { tags: "yes", archived: true, search: 42 },
      color: { projectBy: "one", project: "#ABCDEF", tag: "red", related: "#12345", highlight: null },
      display: { nodeScale: 99, labelSize: -3, textFade: Number.NaN, arrows: true },
      force: { repel: "strong", relatedDistance: 1000, tagStrength: 0.25 },
      open: { color: true },
      extra: { anything: 1 },
    });
    expect(read.filter).toEqual({ ...DEFAULT_GRAPH_SETTINGS.filter, archived: true });
    expect(read.color).toEqual({ ...DEFAULT_GRAPH_SETTINGS.color, projectBy: "one", project: "#abcdef" });
    expect(read.display).toEqual({ ...DEFAULT_GRAPH_SETTINGS.display, nodeScale: 3, labelSize: 10, arrows: true });
    expect(read.force).toEqual({ ...DEFAULT_GRAPH_SETTINGS.force, relatedDistance: 400, tagStrength: 0.25 });
    expect(read.open).toEqual({ ...DEFAULT_GRAPH_SETTINGS.open, color: true });
    expect("extra" in read).toBe(false);
  });

  it("go back to the defaults a section at a time or all at once, keeping which sections are open", () => {
    const changed = sanitizeGraphSettings({ filter: { tags: false }, display: { nodeScale: 2 }, open: { force: true } });
    const display = resetSection(changed, "display");
    expect(display.display).toEqual(DEFAULT_GRAPH_SETTINGS.display);
    expect(display.filter.tags).toBe(false);
    const all = resetAll(changed);
    expect({ ...all, open: DEFAULT_GRAPH_SETTINGS.open }).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(all.open).toEqual(changed.open);
  });

  it("give the simulation its forces, a length and strength per kind of line", () => {
    const forces = forcesOf({ ...DEFAULT_GRAPH_SETTINGS, force: { ...DEFAULT_GRAPH_SETTINGS.force, relatedDistance: 200, tagStrength: 0.1 } });
    expect(forces.links.related.distance).toBe(200);
    expect(forces.links.tag.strength).toBe(0.1);
    expect(forces.repel).toBe(DEFAULT_GRAPH_SETTINGS.force.repel);
  });
});
