// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { configureTextAssets, resolveTextImage, unresolveTextImage } from "../../../../office/src/text-assets.ts";
afterEach(() => vi.unstubAllGlobals());
it("keeps authored paths exactly and strips stale clipboard capabilities", () => {
  vi.stubGlobal("location", new URL("http://127.0.0.1:4500/office/markdown.html"));
  configureTextAssets(`/preview/${"a".repeat(32)}/`, "/notes/메모.md");
  const sources = ["assets/그림 100%.png", "assets/encoded%20name.png", "/notes/image.png", "C:\\notes\\image.png"];
  const urls = sources.map(resolveTextImage);
  expect(urls.map(unresolveTextImage)).toEqual(sources);
  configureTextAssets(`/preview/${"b".repeat(32)}/`, "/notes/메모.md");
  expect(urls.map(unresolveTextImage)).toEqual(sources);
  configureTextAssets(`/preview/${"c".repeat(32)}/`, "/other/다른.md");
  expect(unresolveTextImage(urls[0]!)).toBe("/notes/assets/그림 100%.png");
  expect(resolveTextImage("https://example.com/image.png")).toBe("https://example.com/image.png");
  expect(resolveTextImage("data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
  configureTextAssets(`/preview/${"d".repeat(32)}/`, "/note.md");
  const rootImage = resolveTextImage("image.png");
  configureTextAssets(`/preview/${"e".repeat(32)}/`, "/other/note.md");
  expect(unresolveTextImage(rootImage)).toBe("/image.png");
});
