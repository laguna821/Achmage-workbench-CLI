import { expect, it, vi } from "vitest";
import { LayoutPersistence } from "./layout-persistence.ts";
import type { WorkspaceLayoutRecord } from "@workbench/contracts";

it("serializes rapid saves against the acknowledged revision and does not overwrite after a conflict", async () => {
  let revision = 0;
  const api = {
    layout: vi.fn(async () => ({ record: { key: "global", revision, layout: {}, updatedAt: 0 } as WorkspaceLayoutRecord })),
    saveLayout: vi.fn(async (key: string, expected: number, layout: Record<string, unknown>) => {
      await Promise.resolve();
      if (expected !== revision) throw new Error("conflict");
      return { record: { key, revision: ++revision, layout, updatedAt: 0 } };
    }),
  };
  const store = new LayoutPersistence(api);
  await store.read("global");
  await Promise.all([store.write("global", { marker: 1 }), store.write("global", { marker: 2 })]);
  expect(api.saveLayout.mock.calls.map((call) => call[1])).toEqual([0, 1]);
  revision++;
  await expect(store.write("global", { marker: 3 })).rejects.toThrow("conflict");
  await expect(store.write("global", { marker: 4 })).rejects.toThrow("conflict");
  expect(api.saveLayout).toHaveBeenCalledTimes(3);
  await store.read("global");
  await store.write("global", { marker: 4 });
  expect(api.saveLayout.mock.calls.at(-1)![1]).toBe(3);
});

// The window starts on this device's copy of the layout and replaces it with the gateway's record
// once that is read. A choice the person made in between (a row clicked at once) must not be undone
// by that replacement — the capture stall of U28 round 1 was exactly this.
import { keepChosen } from "./layout-persistence.ts";
import { activeTab, contentKey, withTabs } from "./tabs.ts";
import { setPane, type Layout, type PaneContent } from "./panes.ts";
type V = { kind: string; id?: string };
const content = (kind: string, sessionId: string | null, id?: string): PaneContent<V> => ({ workId: "w", sessionId, view: id ? { kind, id } : { kind } });
const stored = (() => {
  let layout = withTabs<V>({ panes: [{ id: "a", ...content("new", null) }], focus: "a" });
  for (const next of [content("work", "s"), content("browser", "web", "p")]) layout = withTabs(setPane(layout, "a", next), layout);
  return layout;
})();
it("a stored layout read after the person already chose a tab keeps that tab in front, and the stored tabs", () => {
  const local = stored;
  const chosen = withTabs(setPane(local, "a", content("work", "s")), local);
  const restored = { ...stored, panes: stored.panes.map((pane) => ({ ...pane })) } as Layout<V>;
  const kept = keepChosen(restored, chosen, true);
  expect(contentKey(activeTab(kept.panes[0]!))).toBe("session:s");
  expect(kept.panes[0]!.tabs!.map((tab) => contentKey(tab))).toEqual(restored.panes[0]!.tabs!.map((tab) => contentKey(tab)));
});
it("nothing chosen before it was read: the stored layout as it is", () => {
  const restored = stored;
  expect(keepChosen(restored, withTabs(setPane(stored, "a", content("work", "s")), stored), false)).toBe(restored);
});
it("a chosen view the stored layout does not have is added in front", () => {
  const chosen = withTabs(setPane(stored, "a", content("work", "t")), stored);
  const kept = keepChosen(stored, chosen, true);
  expect(contentKey(activeTab(kept.panes[0]!))).toBe("session:t");
  expect(kept.panes[0]!.tabs!.length).toBe(stored.panes[0]!.tabs!.length + 1);
});

// Finding 1 of the capture repair (U38): one window, no other writer. A read whose answer arrives
// after this window's own write landed must not take the window back to the older revision, or the
// next write conflicts with the window itself (409 → "다른 창에서 … 바꿨습니다").
function gateway() {
  let stored: WorkspaceLayoutRecord | null = null;
  const reads: Array<() => void> = [];
  const log: string[] = [];
  const api = {
    holdReads: false,
    layout: vi.fn(async (_key: string) => {
      const answer = stored;
      log.push(`GET → ${answer?.revision ?? "null"}`);
      if (api.holdReads) await new Promise<void>((resolve) => reads.push(resolve));
      return { record: answer };
    }),
    saveLayout: vi.fn(async (key: string, expected: number, layout: Record<string, unknown>) => {
      await Promise.resolve();
      if (expected !== (stored?.revision ?? 0)) { log.push(`PUT ${expected} → 409`); throw new Error("conflict"); }
      stored = { key, revision: expected + 1, layout, updatedAt: 0 };
      log.push(`PUT ${expected} → ${stored.revision}`);
      return { record: stored };
    }),
    releaseReads: () => { api.holdReads = false; for (const resolve of reads.splice(0)) resolve(); },
    otherWindowWrites: (layout: Record<string, unknown>) => { stored = { key: "global", revision: (stored?.revision ?? 0) + 1, layout, updatedAt: 0 }; },
    stored: () => stored,
  };
  return { api, log };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("the report's order: a read answered after this window's write does not make the next write conflict", async () => {
  const { api, log } = gateway();
  const store = new LayoutPersistence(api);
  await store.read("global");                       // GET → null (start)
  api.holdReads = true;
  const reading = store.read("global");             // GET → null, answer delayed
  const first = store.write("global", { marker: 1 });
  await tick();
  api.releaseReads();
  await reading;
  await first;
  await expect(store.write("global", { marker: 2 })).resolves.toMatchObject({ revision: 2 });
  expect(log.filter((line) => line.includes("409"))).toEqual([]);
});

it("a write that starts while a read is out carries the revision of the newest thing this window knows", async () => {
  const { api, log } = gateway();
  const store = new LayoutPersistence(api);
  await store.read("global");
  await store.write("global", { marker: 1 });       // rev 1
  api.holdReads = true;
  const reading = store.read("global");
  const second = store.write("global", { marker: 2 });
  await tick();
  api.releaseReads();
  await Promise.all([reading, second]);
  await store.write("global", { marker: 3 });
  expect(log.filter((line) => line.includes("409"))).toEqual([]);
  expect(api.stored()).toMatchObject({ revision: 3, layout: { marker: 3 } });
});

it("twenty layout changes in a row end with the last one stored and no conflict", async () => {
  const { api, log } = gateway();
  const store = new LayoutPersistence(api);
  const reading = store.read("global");
  const writes = Array.from({ length: 20 }, (_, index) => store.write("global", { marker: index }));
  const late = store.read("global");
  await Promise.all([reading, late, ...writes]);
  expect(log.filter((line) => line.includes("409"))).toEqual([]);
  expect(api.stored()?.layout).toEqual({ marker: 19 });
});

it("a real second writer still conflicts, and once answered saving works again at once", async () => {
  const { api } = gateway();
  const store = new LayoutPersistence(api);
  await store.read("global");
  await store.write("global", { marker: 1 });
  api.otherWindowWrites({ marker: "other" });
  await expect(store.write("global", { marker: 2 })).rejects.toThrow("conflict");
  await store.read("global");                       // the person answered (either choice reads first)
  await expect(store.write("global", { marker: 3 })).resolves.toMatchObject({ revision: 3 });
  await expect(store.write("global", { marker: 4 })).resolves.toMatchObject({ revision: 4 });
});

it("a gateway whose revision went back (its data restored while the window stayed open): reading it again makes saving work", async () => {
  let revision = 5;
  const api = {
    layout: vi.fn(async () => ({ record: { key: "global", revision, layout: {}, updatedAt: 0 } as WorkspaceLayoutRecord })),
    saveLayout: vi.fn(async (key: string, expected: number, layout: Record<string, unknown>) => {
      if (expected !== revision) throw new Error("conflict");
      return { record: { key, revision: ++revision, layout, updatedAt: 0 } };
    }),
  };
  const store = new LayoutPersistence(api);
  await store.read("global");
  revision = 2;
  await expect(store.write("global", { marker: 1 })).rejects.toThrow("conflict");
  // The person answers the notice: the stored layout is read again, although its revision is lower than the one known.
  expect((await store.read("global"))?.revision).toBe(2);
  await store.write("global", { marker: 2 });
  expect(api.saveLayout.mock.calls.at(-1)![1]).toBe(2);
});
