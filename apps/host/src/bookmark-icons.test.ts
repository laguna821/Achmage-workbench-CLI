import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BookmarkIcon, BookmarkIconsResult, BookmarkItem, Bookmarks } from "@workbench/contracts";
import { BookmarkIcons, ICON_MAX, iconLinks, siteOf, sniffIcon } from "./bookmark-icons.ts";
import { BookmarkStore, handleBookmarks } from "./bookmarks.ts";
import { EventBus } from "./bus.ts";
import { createHttpServer } from "./http.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { tempDir } from "./test-temp.ts";

// Site icons for bookmarks (bookmarks2, 0.5.4). Every request goes to a LOCAL stand-in server: the rules
// (what is asked, when, and the bounds) are seen from the server's side.

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((run) => run()));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0]);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 40, 0, 0, 0, 22, 0, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

type Seen = { path: string; cookie?: string; authorization?: string; referer?: string };
/** A stand-in site: `routes` answer by path; every request is written down. */
async function site(routes: Record<string, (req: IncomingMessage, res: ServerResponse, base: string) => void>, host = "127.0.0.1") {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ path, cookie: req.headers.cookie, authorization: req.headers.authorization, referer: req.headers.referer });
    const route = routes[path];
    if (route) route(req, res, base); else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((done) => server.listen(0, host, done));
  cleanup.push(() => { server.closeAllConnections(); server.close(); });
  const base = `http://${host}:${(server.address() as AddressInfo).port}`;
  return { base, seen, paths: () => seen.map((entry) => entry.path) };
}
const html = (body: string) => (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "session=abc; Path=/" }); res.end(`<!doctype html><html><head>${body}</head><body>page</body></html>`); };
const bytes = (data: Buffer, type = "image/png") => (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { "content-type": type }); res.end(data); };
const icons = (options: ConstructorParameters<typeof BookmarkIcons>[1] = {}) => {
  const dir = join(tempDir("wb-bookmark-icons-"), "bookmark-icons");
  return { dir, icons: new BookmarkIcons(dir, { timeoutMs: 1500, ...options }) };
};

describe("what counts as an icon", () => {
  it("a raster image by its first bytes (PNG, ICO, GIF, JPEG, WebP); SVG, HTML and anything else are refused", () => {
    expect(sniffIcon(PNG)).toBe("image/png");
    expect(sniffIcon(ICO)).toBe("image/x-icon");
    expect(sniffIcon(Buffer.from("GIF89a\0\0"))).toBe("image/gif");
    expect(sniffIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffIcon(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    for (const refused of [SVG, Buffer.from("<!doctype html>"), Buffer.from(""), Buffer.from([0, 0, 1, 0, 0, 0])]) expect(sniffIcon(refused)).toBeNull();
  });

  it("the registrable host: the last two labels, three under a country's co. / ac. / go.; addresses as they are", () => {
    expect(siteOf("www.example.com")).toBe("example.com");
    expect(siteOf("smart.hallym.ac.kr")).toBe("hallym.ac.kr");
    expect(siteOf("www.korean.go.kr")).toBe("korean.go.kr");
    expect(siteOf("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
    expect(siteOf("localhost")).toBe("localhost");
  });

  it("a page's <link rel=icon>: best first (16/32 px, PNG); SVG and icons on another site are left out", () => {
    const page = new URL("https://www.example.com/a/b");
    const found = iconLinks(`
      <link rel="stylesheet" href="/x.css">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="shortcut icon" href="/favicon.ico">
      <link href='/icon-32.png' rel=icon sizes="32x32" type="image/png">
      <link rel="icon" href="https://tracker.example.net/i.png">
      <link rel="icon" href="https://static.example.com/i.png?a=1&amp;b=2">
      <link rel="icon" href="javascript:alert(1)">`, page);
    expect(found.map((url) => url.href)).toEqual(["https://www.example.com/icon-32.png", "https://static.example.com/i.png?a=1&b=2", "https://www.example.com/favicon.ico"]);
  });
});

describe("fetching a site's icon (a local stand-in site)", () => {
  it("the page's icon: the page and that icon only, without cookies, credentials or a referrer; kept by the hash of its bytes", async () => {
    const at = await site({ "/": html('<link rel="icon" href="/brand.png">'), "/brand.png": bytes(PNG) });
    const { dir, icons: kept } = icons();
    const hash = await kept.ensure(`${at.base}/`);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(at.paths()).toEqual(["/", "/brand.png"]);
    for (const request of at.seen) expect([request.cookie, request.authorization, request.referer]).toEqual([undefined, undefined, undefined]);
    expect(readdirSync(dir).sort()).toEqual([hash, "index.json"].sort());
    expect(kept.read(hash!)).toEqual({ type: "image/png", bytes: PNG });
    // Every bookmark of that site shows it; asking again asks nobody.
    expect(kept.iconOf(`${at.base}/other/page?q=1`)).toBe(hash);
    await kept.ensure(`${at.base}/deep`);
    expect(at.paths()).toEqual(["/", "/brand.png"]);
    // A restart keeps it.
    expect(new BookmarkIcons(dir).iconOf(`${at.base}/`)).toBe(hash);
  });

  it("no icon named on the page: /favicon.ico", async () => {
    const at = await site({ "/start": html("<title>x</title>"), "/favicon.ico": bytes(ICO, "image/vnd.microsoft.icon") });
    const { icons: kept } = icons();
    expect(await kept.ensure(`${at.base}/start`)).toBeTruthy();
    expect(at.paths()).toEqual(["/start", "/favicon.ico"]);
  });

  it("refuses an SVG (even served as PNG), an HTML page as an icon, and anything over 64 KB", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(ICON_MAX)]);
    for (const [name, icon] of [["svg", bytes(SVG, "image/svg+xml")], ["svg-as-png", bytes(SVG)], ["html", html("")], ["big", bytes(big)]] as const) {
      const at = await site({ "/": html('<link rel="icon" href="/i.png">'), "/i.png": icon, "/favicon.ico": icon });
      const { dir, icons: kept } = icons();
      expect([name, await kept.ensure(`${at.base}/`)]).toEqual([name, null]);
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual(existsSync(dir) ? ["index.json"] : []);
    }
  });

  it("a big icon announced by its length is not read at all", async () => {
    let written = 0;
    const at = await site({ "/": html(""), "/favicon.ico": (_req, res) => { res.writeHead(200, { "content-type": "image/x-icon", "content-length": String(ICON_MAX * 4) }); const chunk = Buffer.alloc(ICON_MAX); const pump = () => { if (written >= 4 || res.destroyed) return; written++; res.write(chunk, pump); }; pump(); } });
    const { icons: kept } = icons();
    expect(await kept.ensure(`${at.base}/`)).toBeNull();
  });

  it("one redirect to the same registrable host is followed; a second one, or one to another host, is not", async () => {
    const same = await site({ "/": html('<link rel="icon" href="/old.png">'), "/old.png": (_req, res, base) => { res.writeHead(301, { location: `${base}/new.png` }); res.end(); }, "/new.png": bytes(PNG) });
    expect(await icons().icons.ensure(`${same.base}/`)).toBeTruthy();
    expect(same.paths()).toEqual(["/", "/old.png", "/new.png"]);

    const elsewhere = await site({ "/x.png": bytes(PNG), "/favicon.ico": bytes(PNG) }, "localhost");
    const off = await site({ "/": html(""), "/favicon.ico": (_req, res) => { res.writeHead(302, { location: `${elsewhere.base}/x.png` }); res.end(); } });
    expect(await icons().icons.ensure(`${off.base}/`)).toBeNull();
    expect(elsewhere.seen).toEqual([]);

    const twice = await site({ "/": html(""), "/favicon.ico": (_req, res, base) => { res.writeHead(302, { location: `${base}/a` }); res.end(); }, "/a": (_req, res, base) => { res.writeHead(302, { location: `${base}/b` }); res.end(); }, "/b": bytes(PNG) });
    expect(await icons().icons.ensure(`${twice.base}/`)).toBeNull();
    expect(twice.paths()).not.toContain("/b");
  });

  it("a site that never answers is given up after the time limit (nothing kept, no error)", async () => {
    const at = await site({ "/": () => { /* never answers */ }, "/favicon.ico": () => { /* never answers */ } });
    const { icons: kept } = icons({ timeoutMs: 300 });
    const started = Date.now();
    expect(await kept.ensure(`${at.base}/`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("only http / https without credentials; never another scheme", async () => {
    const { icons: kept } = icons({ fetch: (() => { throw new Error("must not be asked"); }) as never });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/", "https://user:pw@example.com/", "not an address"]) expect(await kept.ensure(url)).toBeNull();
  });

  it("a site without a usable icon is not asked again for a day — unless 아이콘 가져오기 asks (force)", async () => {
    const at = await site({ "/": html("") });
    let now = 1_000_000;
    const { icons: kept } = icons({ now: () => now });
    expect(await kept.ensure(`${at.base}/`)).toBeNull();
    const asked = at.seen.length;
    expect(await kept.ensure(`${at.base}/`)).toBeNull();
    expect(at.seen.length).toBe(asked);
    await kept.ensure(`${at.base}/`, true);
    expect(at.seen.length).toBe(asked * 2);
    now += 25 * 60 * 60 * 1000;
    await kept.ensure(`${at.base}/`);
    expect(at.seen.length).toBe(asked * 3);
  });

  it("the kept icons are bounded in total: the oldest go first", async () => {
    const one = Buffer.concat([PNG, Buffer.alloc(100, 1)]), two = Buffer.concat([PNG, Buffer.alloc(100, 2)]);
    const a = await site({ "/": html(""), "/favicon.ico": bytes(one) }), b = await site({ "/": html(""), "/favicon.ico": bytes(two) }, "localhost");
    let now = 1;
    const { dir, icons: kept } = icons({ now: () => now++, totalMax: one.length + 10 });
    const first = await kept.ensure(`${a.base}/`), second = await kept.ensure(`${b.base}/`);
    expect(first && second).toBeTruthy();
    expect(kept.iconOf(`${a.base}/`)).toBeUndefined();
    expect(kept.iconOf(`${b.base}/`)).toBe(second);
    expect(readdirSync(dir).sort()).toEqual([second, "index.json"].sort());
  });
});

describe("/api/bookmarks icon routes", () => {
  async function gateway() {
    const dir = tempDir("wb-bookmark-icons-http-");
    const store = new BookmarkStore(join(dir, "data", "bookmarks.json"));
    const kept = new BookmarkIcons(join(dir, "data", "bookmark-icons"), { timeoutMs: 1500 });
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "data", "works"), dataDir: join(dir, "data") });
    const token = "t";
    const server = createHttpServer(manager, new EventBus(), { token, webDir: null, bookmarks: (req, res, url) => handleBookmarks({ store, places: { platform: "linux", home: join(dir, "home"), env: {} }, tempDir: join(dir, "tmp"), icons: kept }, req, res, url) });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanup.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async <T>(method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as T };
    };
    return { store, call };
  }
  const first = (view: Bookmarks) => view.items[0] as BookmarkItem;

  it("adding or importing a bookmark asks no site; opening one (fetch) asks its site once; the item then carries its icon", async () => {
    const at = await site({ "/": html('<link rel="icon" href="/i.png">'), "/i.png": bytes(PNG) });
    const { store, call } = await gateway();
    await call("POST", "/api/bookmarks", { kind: "item", title: "사이트", url: `${at.base}/` });
    store.import("Chrome", { bar: [{ kind: "item", title: "다른 곳", url: `${at.base}/imported` }], other: [] });
    expect(at.seen).toEqual([]);
    const view = (await call<Bookmarks>("POST", "/api/bookmarks/icons/fetch", { url: `${at.base}/` })).body;
    expect(first(view).icon).toMatch(/^[a-f0-9]{64}$/);
    expect(at.paths()).toEqual(["/", "/i.png"]);
    // Every answer that carries the bookmarks carries the icon.
    expect(first((await call<Bookmarks>("GET", "/api/bookmarks")).body).icon).toBe(first(view).icon);
    const icon = (await call<BookmarkIcon>("GET", `/api/bookmarks/icons/${first(view).icon}`)).body;
    expect([icon.type, Buffer.from(icon.data, "base64").equals(PNG)]).toEqual(["image/png", true]);
    expect((await call<{ code: string }>("GET", `/api/bookmarks/icons/${"0".repeat(64)}`)).status).toBe(404);
  });

  it("an address that is not a bookmark is never fetched", async () => {
    const at = await site({ "/": html("") });
    const { call } = await gateway();
    const refused = await call<{ code: string }>("POST", "/api/bookmarks/icons/fetch", { url: `${at.base}/` });
    expect([refused.status, refused.body.code]).toEqual([404, "bookmark_missing"]);
    expect(at.seen).toEqual([]);
  });

  it("아이콘 가져오기: one site at a time per site (not per bookmark), and one line says what came of it", async () => {
    const good = await site({ "/": html(""), "/favicon.ico": bytes(ICO) }), bare = await site({ "/": html("") }, "localhost");
    const { call } = await gateway();
    for (const url of [`${good.base}/a`, `${good.base}/b`, `${bare.base}/`]) await call("POST", "/api/bookmarks", { kind: "item", title: url, url });
    const result = (await call<BookmarkIconsResult>("POST", "/api/bookmarks/icons/fetch-all")).body;
    expect([result.fetched, result.failed, result.message]).toEqual([1, 1, "사이트 아이콘 1개를 가져왔습니다. 1곳은 아이콘을 찾지 못했습니다."]);
    expect(good.paths()).toEqual(["/a", "/favicon.ico"]);
    expect(result.bookmarks.items.map((node) => Boolean((node as BookmarkItem).icon))).toEqual([true, true, false]);
  });

  it("되돌리기: a removed folder comes back whole at its place", async () => {
    const { call } = await gateway();
    await call("POST", "/api/bookmarks", { kind: "item", title: "가", url: "https://a.example/" });
    let view = (await call<Bookmarks>("POST", "/api/bookmarks", { kind: "folder", title: "폴더" })).body;
    const folderId = view.items[1]!.id;
    view = (await call<Bookmarks>("POST", "/api/bookmarks", { kind: "item", title: "안", url: "https://in.example/", parentId: folderId })).body;
    const removed = view.items[1]!;
    await call("DELETE", `/api/bookmarks/items/${folderId}`);
    view = (await call<Bookmarks>("POST", "/api/bookmarks/restore", { node: removed, parentId: null, index: 0 })).body;
    expect(view.items.map((node) => node.title)).toEqual(["폴더", "가"]);
    expect(view.items[0]).toEqual(removed);
  });
});
