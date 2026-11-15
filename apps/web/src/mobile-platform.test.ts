// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadAttachment } from "./mobile-platform.ts";

// What the browser is handed when a file is saved: the blob behind the object URL and the file name.
let handed: Blob[] = [], names: string[] = [];
beforeEach(() => {
  handed = []; names = [];
  URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => { handed.push(blob as Blob); return `blob:${location.origin}/${handed.length}`; });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
});
afterEach(() => { vi.restoreAllMocks(); });

it("hands a downloaded attachment to the browser as plain bytes under its own name, whatever it contains", async () => {
  // A browser that opens the object URL instead of saving it must not get a page or picture that
  // runs script on this app's address, where a remembered connection is kept.
  const page = new File(["<script>parent.postMessage(localStorage.length, '*')</script>"], "보고서.html", { type: "text/html" });
  const picture = new File(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], "그림.svg", { type: "image/svg+xml" });
  downloadAttachment(page);
  downloadAttachment(picture);
  expect(handed.map(blob => blob.type)).toEqual(["application/octet-stream", "application/octet-stream"]);
  expect(names).toEqual(["보고서.html", "그림.svg"]);
  // The bytes are the file's own.
  expect(await handed[0]!.text()).toBe(await page.text());
  expect(handed[1]!.size).toBe(picture.size);
});
