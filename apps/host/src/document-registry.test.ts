import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Artifact } from "@workbench/contracts";
import { DocumentRegistry } from "./document-registry.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-document-views-")); dirs.push(dir);
  writeFileSync(join(dir, "a.md"), "A"); writeFileSync(join(dir, "worktree-a.md"), "A");
  symlinkSync(join(dir, "a.md"), join(dir, "alias.md"));
  const files = { a: "a.md", duplicate: "a.md", alias: "alias.md", other: "worktree-a.md" };
  let now = 1000;
  const registry = new DocumentRegistry((id) => ({ id, path: join(dir, files[id as keyof typeof files]), name: id, revision: 1 } as Artifact), () => now);
  return { registry, advance: () => { now += 60_001; }, wait: (ms: number) => { now += ms; } };
}
const input = (viewId: string, claim = true) => ({ viewId, windowId: `window-${viewId}`, claim });

it("grants one writer for duplicate IDs and symlink aliases while independent worktree files stay independent", () => {
  const { registry } = fixture();
  const first = registry.open("a", input("first"));
  const second = registry.open("duplicate", input("second"));
  const alias = registry.open("alias", input("alias"));
  expect(first.view.mode).toBe("write");
  expect(second.view.mode).toBe("read"); expect(alias.writer?.viewId).toBe("first");
  expect(registry.open("other", input("other")).view.mode).toBe("write");
  expect(() => registry.assertWrite("duplicate", { viewId: "second", writeToken: null })).toThrow(/편집 권한/);
  expect(() => registry.assertWrite("a")).toThrow(/다른 탭/);
  expect(() => registry.assertWrite("alias", { viewId: "first", writeToken: first.writeToken })).not.toThrow();
  expect(() => registry.assertWrite("other", { viewId: "first", writeToken: first.writeToken })).toThrow(/편집 권한/);
  expect(JSON.stringify(registry.list())).not.toContain(first.writeToken);
});

it("does not silently give a reader ownership and fences expired capabilities after an explicit reclaim", () => {
  const { registry, advance } = fixture();
  const first = registry.open("a", input("first"));
  registry.open("a", input("second"));
  registry.close("first", "wrong-window");
  expect(registry.open("a", input("second", false)).writer?.viewId).toBe("first");
  registry.close("first", "window-first");
  expect(registry.open("a", input("second", false)).view.mode).toBe("read");
  expect(() => registry.assertWrite("a", { viewId: "second", writeToken: null })).toThrow(/편집 권한/);
  const second = registry.open("a", input("second"));
  expect(second.view.mode).toBe("write");
  expect(() => registry.assertWrite("a", { viewId: "first", writeToken: first.writeToken })).toThrow(/편집 권한/);
  advance();
  expect(registry.list()).toEqual([]);
  expect(() => registry.assertWrite("a", { viewId: "second", writeToken: second.writeToken })).toThrow(/편집 권한/);
  const renewed = registry.open("a", input("second"));
  expect(renewed.writeToken).not.toBe(second.writeToken);
  expect(() => registry.assertWrite("a", { viewId: "second", writeToken: second.writeToken })).toThrow(/편집 권한/);
  expect(() => registry.assertWrite("a", { viewId: "second", writeToken: renewed.writeToken })).not.toThrow();
});

// U38 finding 5: a window that disappeared without pagehide (crash, killed) kept its lease for the
// whole minute, so 편집 권한 받기 elsewhere did nothing. With nothing unsaved and its heartbeat
// (every 10 s) missed, it gives way at once to an explicit claim. With unsaved edits it is protected
// until the lease runs out, as before; a live writer (heartbeat on time) is never taken.
it("an explicit claim takes the lease of a writer that missed its heartbeat and has nothing unsaved", () => {
  const { registry, wait } = fixture();
  const gone = registry.open("a", { ...input("gone"), dirty: false });
  wait(5_000);
  expect(registry.open("a", input("here")).view.mode).toBe("read");
  wait(11_000);
  expect(registry.open("a", input("here", false)).view.mode).toBe("read");
  const here = registry.open("a", input("here"));
  expect(here.view.mode).toBe("write");
  expect(here.writer?.viewId).toBe("here");
  expect(() => registry.assertWrite("a", { viewId: "gone", writeToken: gone.writeToken })).toThrow(/편집 권한/);
  // The window was only slow: it comes back as a reader.
  expect(registry.open("a", input("gone", false)).view.mode).toBe("read");
});

it("a writer with unsaved edits keeps its lease until it runs out, even when its heartbeat stopped", () => {
  const { registry, wait } = fixture();
  registry.open("a", { ...input("gone"), dirty: true });
  wait(30_000);
  expect(registry.open("a", input("here")).view.mode).toBe("read");
  wait(30_001);
  expect(registry.open("a", input("here")).view.mode).toBe("write");
});
