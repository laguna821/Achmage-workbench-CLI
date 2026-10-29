import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Folder, SequencedEvent, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { folderColor, folderIcon, liftOut } from "./folders.ts";
import { HttpError, SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

const folder = (id: string, parentId: string | null, sort: number): Folder => ({ id, parentId, name: id, sort, archivedAt: null });
const work = (id: string, folderId: string | null, sort: number, archivedAt: number | null = null) =>
  ({ id, title: id, titleSource: "user", folderId, cwd: `/w/${id}`, cwdManaged: true, activeSessionId: null, pinned: false, sort, archivedAt, createdAt: 0, updatedAt: 0 }) as Work;

describe("deleting a folder (contents move up)", () => {
  it("puts the subfolders where the folder was, in their order, and the projects in the parent", () => {
    const folders = [folder("강의", null, 0), folder("2026-2", "강의", 1), folder("2026-1", "강의", 0), folder("연구", null, 1), folder("행정", null, 2)];
    const plan = liftOut(folders, [work("w1", "강의", 5), work("w2", "강의", -3, 9), work("w3", "연구", 0)], "강의");
    expect(plan.parentId).toBeNull();
    expect(plan.folders.map((entry) => entry.id)).toEqual(["2026-1", "2026-2"]);
    // Between the folder's old neighbours: before "연구" (sort 1), after nothing above it.
    const [first, second] = plan.folders;
    expect(first!.parentId).toBeNull();
    expect(first!.sort).toBeLessThan(second!.sort);
    expect(second!.sort).toBeLessThan(1);
    // Archived projects come along (they stay restorable), with their own order keys.
    expect(plan.works.map((entry) => [entry.id, entry.folderId, entry.sort])).toEqual([
      ["w1", null, 5],
      ["w2", null, -3],
    ]);
  });

  it("moves a nested folder's contents to its own parent", () => {
    const plan = liftOut([folder("a", null, 0), folder("b", "a", 0), folder("c", "b", 0), folder("d", "a", 1)], [work("w", "b", 0)], "b");
    expect(plan.parentId).toBe("a");
    expect(plan.folders).toMatchObject([{ id: "c", parentId: "a" }]);
    // Where "b" was: still before its old neighbour "d".
    expect(plan.folders[0]!.sort).toBeLessThan(1);
    expect(plan.works).toMatchObject([{ id: "w", folderId: "a" }]);
  });

  it("deletes through the gateway: the folder leaves the store, the rest moves up, events tell the screen", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-folders-"));
    const store = new Store(join(dir, "state.sqlite"));
    const bus = new EventBus();
    const events: SequencedEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
    const top = manager.createFolder("강의", null);
    const term = manager.createFolder("2026-2", top.id);
    const inner = manager.createFolder("과제", term.id);
    const project = manager.createWork({ title: "7주차", folderId: term.id });
    const empty = manager.createFolder("빈 폴더", null);

    expect(manager.deleteFolder(empty.id)).toEqual({ parentId: null, folders: [], works: [] });
    const result = manager.deleteFolder(term.id);
    expect(result).toEqual({ parentId: top.id, folders: [inner.id], works: [project.id] });
    const snapshot = manager.snapshot();
    expect(snapshot.folders.map((entry) => entry.id).sort()).toEqual([top.id, inner.id].sort());
    expect(snapshot.folders.find((entry) => entry.id === inner.id)?.parentId).toBe(top.id);
    expect(snapshot.works.find((entry) => entry.id === project.id)?.folderId).toBe(top.id);
    expect(store.folders().map((entry) => entry.id).sort()).toEqual([top.id, inner.id].sort());
    expect(events.filter((event) => event.type === "folder.removed").map((event) => (event.type === "folder.removed" ? event.folderId : ""))).toEqual([empty.id, term.id]);
    expect(() => manager.deleteFolder(term.id)).toThrow(HttpError);
    store.close();
  });
});

describe("folder colour and icon", () => {
  it("take #rrggbb (or #rgb) and an icon name, null clears them, the rest is refused", () => {
    expect(folderColor("#3E63DD")).toBe("#3e63dd");
    expect(folderColor("#abc")).toBe("#aabbcc");
    expect(folderColor(null)).toBeNull();
    expect(folderColor("red")).toBeUndefined();
    expect(folderColor("url(x)")).toBeUndefined();
    expect(folderIcon("book")).toBe("book");
    expect(folderIcon("")).toBeNull();
    expect(folderIcon("../x")).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "wb-folders-"));
    const store = new Store(join(dir, "state.sqlite"));
    const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
    const made = manager.createFolder("연구", null);
    expect(manager.updateFolder(made.id, { color: "#30A46C", icon: "book" })).toMatchObject({ color: "#30a46c", icon: "book", name: "연구" });
    expect(manager.updateFolder(made.id, { color: null })).toMatchObject({ color: null, icon: "book" });
    expect(() => manager.updateFolder(made.id, { color: "blue" })).toThrow(HttpError);
    expect(store.folders()[0]).toMatchObject({ icon: "book", color: null });
    store.close();
  });
});
