import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "./store.ts";
import { Workspaces } from "./workspaces.ts";
import { EventBus } from "./bus.ts";
import { WorkspaceLayouts } from "./layouts.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-layouts-")); cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const store = new Store(join(dir, "state.sqlite")); cleanup.push(() => store.close());
  const spaces = new Workspaces(store, "local", new EventBus());
  const now = Date.now();
  const workspace = { id: "workspace-one", workId: "project-one", hostId: "local", label: "기본", kind: "folder" as const, cwd: dir, managed: false, worktree: null, archivedAt: null, removedAt: null, createdAt: now, updatedAt: now };
  store.saveWorkspace(workspace);
  // Reload the manager, as on a new process, to pick up the stored workspace.
  return { store, layouts: () => new WorkspaceLayouts(store, new Workspaces(store, "local", new EventBus())), spaces };
}
function layout(id = "tab-one") {
  const content = { view: { kind: "new", folderId: null }, workId: null, sessionId: null };
  return { version: 2, focus: "a", panes: [{ ...content, id: "a", tabs: [{ ...content, id }], activeTabId: id, recentTabIds: [id] }] };
}
it("keeps independent records and rejects stale writes from another window without changing either layout", () => {
  const { layouts } = fixture(), left = layouts(), right = layouts();
  expect(left.read("global")).toBeNull();
  left.write("global", 0, layout());
  left.write("workspace-one", 0, layout("space-tab"));
  const saved = right.read("global")!;
  left.write("global", 1, layout("left-tab"));
  expect(() => right.write("global", saved.revision, layout("right-tab"))).toThrow(/다른 창/);
  expect(right.read("global")!.layout).toEqual(layout("left-tab"));
  expect(right.read("workspace-one")!.layout).toEqual(layout("space-tab"));
  expect(right.write("global", 2, layout("right-tab")).revision).toBe(3);
});
it("preserves old preferences exactly; skips a repeated tab and drops a tree that no longer fits, not the layout (skin 2 · B)", () => {
  const { store, layouts } = fixture(), raw = '{"paneLayout":{"version":1},"legacy":"keep 🌊"}';
  store.setMeta("ui.prefs", raw); const saved = layouts();
  expect(store.getMeta("layouts.legacyPrefs")).toBe(raw);
  saved.write("global", 0, layout());
  expect(store.getMeta("ui.prefs")).toBe(raw);
  expect(saved.write("global", 1, { ...layout(), tree: { kind: "pane", id: "missing" } }).layout).toEqual(layout());
  const repeated = layout(); repeated.panes[0]!.tabs.push(repeated.panes[0]!.tabs[0]!);
  expect(saved.write("global", 2, repeated).layout).toEqual(layout());
  expect(() => saved.write("global", 3, { version: 2, focus: "a", panes: [] })).toThrow(/형식/);
  expect(() => saved.write("unknown-space", 0, layout())).toThrow();
  expect(saved.read("global")!.revision).toBe(3);
});
it("keeps every readable tab when one tab cannot be read; a pane left empty folds away (skin 2 · B)", () => {
  const { layouts } = fixture(), saved = layouts();
  const tab = (id: string, kind = "new", workId: string | null = null) => ({ id, view: { kind, folderId: null }, workId, sessionId: null });
  const stored = { version: 2, focus: "b", tree: { kind: "split", id: "s", axis: "horizontal", ratio: 0.5, first: { kind: "pane", id: "a" }, second: { kind: "pane", id: "b" } }, panes: [
    { ...tab("x"), id: "a", tabs: [tab("one"), tab("bad id!"), tab("future", "a-kind-from-later", "work-1"), tab("broken", "new", "not ok/")], activeTabId: "bad id!", recentTabIds: ["bad id!", "one"] },
    { ...tab("x"), id: "b", tabs: [tab("one"), { id: "noview" }], activeTabId: "one", recentTabIds: ["one"] },
  ] };
  const record = saved.write("global", 0, stored);
  const panes = record.layout.panes as { id: string; tabs: { id: string }[]; activeTabId: string }[];
  // The future kind is the web app's to know: the gateway keeps it.
  expect(panes.map((pane) => [pane.id, pane.tabs.map((entry) => entry.id), pane.activeTabId])).toEqual([["a", ["one", "future"], "one"]]);
  expect(record.layout.focus).toBe("a");
  expect(record.layout.tree).toBeUndefined();
});
it("accepts a remote device's own record beside the desktop's (skin 2 · B)", () => {
  const { layouts } = fixture(), saved = layouts();
  saved.write("global", 0, layout("desk"));
  saved.write("device:phone-1", 0, layout("phone"));
  expect(saved.read("global")!.layout).toEqual(layout("desk"));
  expect(saved.read("device:phone-1")).toMatchObject({ key: "device:phone-1", revision: 1, layout: layout("phone") });
  expect(saved.read("device:phone-2")).toBeNull();
  expect(() => saved.write("device:../global", 0, layout())).toThrow();
});
