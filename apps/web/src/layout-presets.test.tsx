import { describe, it, expect } from "vitest";
import { applyPanePreset } from "./layout-presets.ts";
import { minimumSize, paneGeometry, restoreLayout, singleLayout, treeOf } from "./panes.ts";
import { addBackgroundTab, tabsOf, withTabs } from "./tabs.ts";

type View = { kind: string; artifactId?: string };
const empty = () => ({ view: { kind: "new" }, workId: null, sessionId: null });
describe("project grid presets", () => {
  it("keeps document/session tab identities and state across nine panes and back to one", () => {
    let layout = withTabs(singleLayout<View>({ kind: "work" }, "w"));
    layout = addBackgroundTab(layout, layout.focus, { view: { kind: "document", artifactId: "doc" }, workId: "w", sessionId: null });
    const original = layout.panes.flatMap(tabsOf).map(t => t.id);
    const grid = applyPanePreset(layout, 9, empty);
    expect(grid.panes).toHaveLength(9);
    expect(grid.grid).toBe(3);
    const ids = grid.panes.flatMap(tabsOf).map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(original));
    const single = applyPanePreset(grid, 1, empty);
    expect(single.panes).toHaveLength(1);
    expect(single.panes.flatMap(tabsOf).map(t => t.id).sort()).toEqual([...ids].sort());
  });
  it("restores nine-pane density and fits a regular laptop work area without collapsing", () => {
    const grid = applyPanePreset(withTabs(singleLayout<View>({ kind: "new" }, null)), 9, empty);
    const restored = restoreLayout({ version: 2, ...grid }, (v): v is View => !!v && typeof v === "object" && "kind" in v, grid);
    expect(restored.grid).toBe(3);
    expect(minimumSize(treeOf(restored), true)).toEqual({ width: 734, height: 554 });
    const geometry = paneGeometry(treeOf(restored), 1080, 700, true);
    expect(Object.values(geometry.panes)).toHaveLength(9);
    for (const rect of Object.values(geometry.panes)) { expect(rect.width).toBeGreaterThan(240); expect(rect.height).toBeGreaterThan(180); }
  });
});
