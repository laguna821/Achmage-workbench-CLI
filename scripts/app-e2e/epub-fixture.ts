import { createRequire } from "node:module";
const require = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url));
const JSZip = require("jszip");

export const EPUB_FIRST = '\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First chapter</title><link rel="stylesheet" href="../styles/book.css"/></head><body>\r\n<h1 id="chapter1">First chapter</h1>\r\n<p id="p1">First paragraph.</p>\r\n<p id="p2">Second paragraph remains.</p>\r\n<img alt="Book image" src="../images/picture.png"/><a href="two.xhtml#chapter2">Next chapter</a><script>window.__epubIntrusion=1</script><img src="https://example.invalid/blocked.png" onerror="window.__epubIntrusion=2"/>\r\n</body></html>\r\n';
export const EPUB_SECOND = '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second chapter</title></head><body><h1 id="chapter2">Second chapter</h1><p>Second chapter text stays.</p><a href="one.xhtml#p1">Back to first</a></body></html>\n';

/** Entirely generated books, including opaque parts the editor must retain. */
export async function epubFixture(text = "First paragraph.", options: { fixed?: boolean; broken?: boolean; drm?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file("OEBPS/book.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:workbench-native-epub</dc:identifier><dc:title>Native EPUB book</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-20T00:00:00Z</meta>${options.fixed ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}</metadata><manifest><item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="styles/book.css" media-type="text/css"/><item id="image" href="images/picture.png" media-type="image/png"/><item id="script" href="evil.js" media-type="text/javascript"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`);
  zip.file("OEBPS/nav.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="text/one.xhtml">First chapter</a></li><li><a href="text/two.xhtml">Second chapter</a></li></ol></nav></body></html>');
  zip.file("OEBPS/text/one.xhtml", EPUB_FIRST.replace("First paragraph.", text));
  zip.file("OEBPS/text/two.xhtml", options.broken ? '<html><body><p>Broken <b>markup</p></body></html>' : EPUB_SECOND);
  zip.file("OEBPS/styles/book.css", 'body { color: rgb(23, 57, 85); } h1 { font-size: 28px; } img { max-width: 64px; }');
  zip.file("OEBPS/images/picture.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=", "base64"));
  zip.file("OEBPS/evil.js", 'window.__epubIntrusion=3');
  zip.file("future/unknown.bin", Buffer.from([0, 17, 128, 255]));
  if (options.drm) zip.file("META-INF/rights.xml", "<rights/>");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
export async function epubEntry(bytes: Uint8Array, name: string): Promise<Buffer | null> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(name)?.async("nodebuffer") ?? null;
}
