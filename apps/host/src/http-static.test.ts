import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveStatic } from "./http.ts";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve() {
  const web = mkdtempSync(join(tmpdir(), "wb-static-"));
  dirs.push(web);
  mkdirSync(join(web, "office", "pdf-runtime"), { recursive: true });
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<p>앱</p>");
  writeFileSync(join(web, "office", "pdf-runtime", "pdfium.wasm"), Buffer.alloc(4096, 7));
  writeFileSync(join(web, "assets", "index-abc123.js"), "export {}");
  const server = createServer((req, res) => serveStatic(res, web, new URL(req.url!, "http://x").pathname, {}, req));
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { web, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("editor files that are not content-hashed get a validator (B6)", () => {
  it("pdfium.wasm, fonts …: an ETag and Last-Modified; asked again with them, 304 without the bytes", async () => {
    const { base } = await serve();
    const first = await fetch(`${base}/office/pdf-runtime/pdfium.wasm`);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const tag = first.headers.get("etag"), modified = first.headers.get("last-modified");
    expect(tag).toMatch(/^"[\w-]+"$/);
    expect(modified).toBeTruthy();
    expect((await first.arrayBuffer()).byteLength).toBe(4096);
    const again = await fetch(`${base}/office/pdf-runtime/pdfium.wasm`, { headers: { "if-none-match": tag! } });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    const since = await fetch(`${base}/office/pdf-runtime/pdfium.wasm`, { headers: { "if-modified-since": modified! } });
    expect(since.status).toBe(304);
  });

  it("a changed file (an update) is sent again in full", async () => {
    const { base, web } = await serve();
    const tag = (await fetch(`${base}/office/pdf-runtime/pdfium.wasm`)).headers.get("etag")!;
    writeFileSync(join(web, "office", "pdf-runtime", "pdfium.wasm"), Buffer.alloc(5000, 8));
    utimesSync(join(web, "office", "pdf-runtime", "pdfium.wasm"), new Date(), new Date(Date.now() + 5000));
    const again = await fetch(`${base}/office/pdf-runtime/pdfium.wasm`, { headers: { "if-none-match": tag } });
    expect(again.status).toBe(200);
    expect((await again.arrayBuffer()).byteLength).toBe(5000);
  });

  it("pages stay no-store without a validator; hashed files stay immutable", async () => {
    const { base } = await serve();
    const page = await fetch(`${base}/`);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("etag")).toBeNull();
    const hashed = await fetch(`${base}/assets/index-abc123.js`);
    expect(hashed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
