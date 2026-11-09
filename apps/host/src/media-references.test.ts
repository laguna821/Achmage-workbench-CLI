import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { artifactCacheKey } from "@workbench/contracts";
import { Attachments } from "./attachments.ts";
import { captureMessageMedia, resolveMediaReference } from "./media-references.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const image = (text: string) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(text)]);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wb-media-")); roots.push(root);
  const cwd = join(root, "project"); mkdirSync(cwd);
  return { root, cwd, store: new Attachments(join(root, "data")), context: { hostId: "host", workspaceId: "workspace", cwd, sourceMessageId: "answer" } };
}
test("preserves the message image after the same Korean path is overwritten", () => {
  const f = fixture(), path = join(f.cwd, "그림 결과.png");
  writeFileSync(path, image("first"));
  const first = resolveMediaReference(f.store, f.context, "그림%20결과.png");
  writeFileSync(path, image("second"));
  const second = resolveMediaReference(f.store, { ...f.context, sourceMessageId: "next" }, path);
  expect(first.reference?.artifactId).toBe(second.reference?.artifactId);
  expect(artifactCacheKey(first.reference!)).not.toBe(artifactCacheKey(second.reference!));
  expect(readFileSync(f.store.path(first.id))).toEqual(image("first"));
  expect(readFileSync(f.store.path(second.id))).toEqual(image("second"));
});
test("refuses parent traversal and symlink escape from the execution workspace", () => {
  const f = fixture(); writeFileSync(join(f.root, "outside.png"), image("outside"));
  expect(() => resolveMediaReference(f.store, f.context, "../outside.png")).toThrow(/작업공간 밖/);
  if (process.platform !== "win32") {
    symlinkSync(join(f.root, "outside.png"), join(f.cwd, "link.png"));
    expect(() => resolveMediaReference(f.store, f.context, "link.png")).toThrow(/작업공간 밖/);
  }
  expect(f.store.count()).toBe(0);
});
test("captures local Markdown images once and leaves external URLs untouched", () => {
  const f = fixture(), path = join(f.cwd, "그림 결과.png"); writeFileSync(path, image("first"));
  const text = '![결과](<그림 결과.png>) ![web](https://example.com/remote.png)';
  const captured = captureMessageMedia(f.store, f.context, text);
  writeFileSync(path, image("overwritten"));
  expect(captured).toHaveLength(1);
  expect(captureMessageMedia(f.store, f.context, text, captured)).toEqual(captured);
  expect(readFileSync(f.store.path(captured[0]!.attachment.id))).toEqual(image("first"));
});
