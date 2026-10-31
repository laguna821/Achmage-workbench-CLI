// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { preparePrintHtml } from "../../../../office/src/print-html.ts";
import { stampPdfLinks } from "../../../../office/src/pdf-output-links.ts";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "../../../../../vendor/ieumoffice/node_modules/pdf-lib";

afterEach(() => vi.unstubAllGlobals());

it("resolves relative document grants and authored bases before embedding CSS and pictures", async () => {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
    seen.push(url.pathname);
    const css = url.pathname.endsWith(".css");
    return { ok: true, blob: async () => new Blob([css ? 'p{background:url(picture.svg)}' : '<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: css ? "text/css" : "image/svg+xml" }) };
  }));
  const job = await preparePrintHtml('<html><head><base href="assets/"><link rel="stylesheet" href="print.css"></head><body><p>한글</p><img src="picture.svg"></body></html>', { baseUrl: "/preview/current/" });
  expect(seen).toEqual(["/preview/current/assets/print.css", "/preview/current/assets/picture.svg"]);
  expect(job.html).toContain("workbench-print-asset:0:");
  expect(job.assets).toHaveLength(1); expect(job.assets?.[0]?.mime).toBe("image/svg+xml");
  expect(job.html).toContain("한글"); expect(job.html).not.toContain("<base"); expect(job.html).not.toContain("<link");
});

it("accepts the original Markdown absolute UI base with a relative document grant", async () => {
  const job = await preparePrintHtml(`<html><head><base href="${location.origin}/office/markdown.html"></head><body>Original renderer</body></html>`, { baseUrl: "/preview/current/" });
  expect(job.html).toContain("Original renderer");
});

it("does not read assets outside the current document grant", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(preparePrintHtml('<img src="/preview/another/private.png">', { baseUrl: "/preview/current/" })).rejects.toThrow("현재 문서");
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves URL and slide destinations when the native PDF has no link annotations", async () => {
  const original = await PDFDocument.create(); original.addPage([960, 540]); original.addPage([960, 540]);
  const bytes = await stampPdfLinks(Uint8Array.from(await original.save()).buffer, [[
    { x: 0.1, y: 0.2, w: 0.3, h: 0.1, href: "https://example.com/output" },
    { x: 0.1, y: 0.4, w: 0.3, h: 0.1, href: "#pg2" },
  ]]);
  const pdf = await PDFDocument.load(bytes), links = pdf.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
  expect(links.size()).toBe(2);
  const external = links.lookup(0, PDFDict).lookup(PDFName.of("A"), PDFDict);
  expect(external.lookup(PDFName.of("URI"), PDFString).decodeText()).toBe("https://example.com/output");
  const internal = links.lookup(1, PDFDict).lookup(PDFName.of("Dest"), PDFArray);
  expect(internal.get(0).toString()).toBe(pdf.getPage(1).ref.toString());
});
