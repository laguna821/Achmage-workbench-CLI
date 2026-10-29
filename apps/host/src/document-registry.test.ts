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
  return { registry, advance: () => { now += 60_001; } };
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
