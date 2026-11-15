import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BookmarkImportResult, BookmarkNode, Bookmarks, BookmarkSource } from "@workbench/contracts";
import type { BrowserPlaces, ImportedNode } from "./bookmark-import.ts";
import { BookmarkStore, handleBookmarks } from "./bookmarks.ts";
import { EventBus } from "./bus.ts";
import { createHttpServer } from "./http.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { tempDir } from "./test-temp.ts";

// The app's own bookmarks (bookmarks unit, 0.5.1): one ordered set of items and folders in the gateway's
// data, changed by a person only; an import never overwrites what is there.

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((run) => run()));

const outline = (nodes: (BookmarkNode | ImportedNode)[], depth = 0): string[] => nodes.flatMap((node) => node.kind === "folder"
  ? [`${"  ".repeat(depth)}${node.title}/`, ...outline(node.children, depth + 1)]
  : [`${"  ".repeat(depth)}${node.title} → ${node.url}`]);
const item = (title: string, url: string): ImportedNode => ({ kind: "item", title, url });
const folder = (title: string, children: ImportedNode[]): ImportedNode => ({ kind: "folder", title, children });
const id = (view: Bookmarks, title: string): string => {
  const find = (nodes: BookmarkNode[]): string | null => { for (const node of nodes) { if (node.title === title) return node.id; if (node.kind === "folder") { const inner = find(node.children); if (inner) return inner; } } return null; };
  const found = find(view.items);
  if (!found) throw new Error(`no bookmark named ${title}`);
  return found;
};
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return (error as { code?: string }).code ?? String(error); } return "ok"; };
const store = () => new BookmarkStore(join(tempDir("wb-bookmarks-"), "bookmarks.json"));

const BROWSER = {
  bar: [item("한림대학교", "https://www.hallym.ac.kr/"), folder("수업", [item("스마트캠퍼스", "https://smart.hallym.ac.kr/"), folder("자료", [item("RISS", "https://www.riss.kr/")])])],
  other: [item("국립국어원", "https://www.korean.go.kr/")],
};

describe("the app's bookmarks", () => {
  it("starts empty with the bar on; adds items and folders in order, at a place when one is given", () => {
    const marks = store();
    expect(marks.view()).toEqual({ showBar: true, items: [] });
    marks.add({ kind: "item", title: "한림대학교", url: "https://www.hallym.ac.kr/" });
    marks.add({ kind: "folder", title: "수업" });
    marks.add({ kind: "item", title: "  맨 앞  ", url: "https://first.example/", index: 0 });
    const view = marks.add({ kind: "item", title: "", url: "https://smart.hallym.ac.kr/login", parentId: id(marks.view(), "수업") });
    expect(outline(view.items)).toEqual(["맨 앞 → https://first.example/", "한림대학교 → https://www.hallym.ac.kr/", "수업/", "  smart.hallym.ac.kr → https://smart.hallym.ac.kr/login"]);
  });

  it("refuses what a web tab could not open, a folder with no name, and a place that is not there", () => {
    const marks = store();
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "https://user:pw@example.com/", "not an address", ""]) expect(refusal(() => marks.add({ kind: "item", title: "x", url }))).toBe("bookmark_url");
    expect(refusal(() => marks.add({ kind: "folder", title: "   " }))).toBe("bookmark_title");
    expect(refusal(() => marks.add({ kind: "item", title: "x", url: "https://a.example/", parentId: "nowhere" }))).toBe("bookmark_missing");
    expect(marks.view().items).toEqual([]);
  });

  it("renames, changes an address, moves (along the bar, into and out of a folder) and deletes", () => {
    const marks = store();
    for (const [name, host] of [["가", "a"], ["나", "b"], ["다", "c"]]) marks.add({ kind: "item", title: name!, url: `https://${host}.example/` });
    marks.add({ kind: "folder", title: "폴더" });
    let view = marks.update(id(marks.view(), "가"), { title: "가나다" });
    view = marks.update(id(view, "나"), { url: "https://changed.example/" });
    expect(outline(view.items).slice(0, 2)).toEqual(["가나다 → https://a.example/", "나 → https://changed.example/"]);
    view = marks.move(id(view, "다"), null, 0);
    expect(view.items.map((node) => node.title)).toEqual(["다", "가나다", "나", "폴더"]);
    view = marks.move(id(view, "다"), null, 2);
    expect(view.items.map((node) => node.title)).toEqual(["가나다", "나", "다", "폴더"]);
    view = marks.move(id(view, "나"), id(view, "폴더"), 0);
    expect(outline(view.items)).toEqual(["가나다 → https://a.example/", "다 → https://c.example/", "폴더/", "  나 → https://changed.example/"]);
    view = marks.move(id(view, "나"), null, 99);
    expect(view.items.map((node) => node.title)).toEqual(["가나다", "다", "폴더", "나"]);
    // A folder never goes into itself.
    marks.add({ kind: "folder", title: "안쪽", parentId: id(view, "폴더") });
    expect(refusal(() => marks.move(id(marks.view(), "폴더"), id(marks.view(), "안쪽"), 0))).toBe("bookmark_move");
    expect(refusal(() => marks.update("nowhere", { title: "x" }))).toBe("bookmark_missing");
    expect(refusal(() => marks.update(id(marks.view(), "폴더"), { url: "https://a.example/" }))).toBe("bookmark_url");
    view = marks.remove(id(marks.view(), "폴더"));
    expect(view.items.map((node) => node.title)).toEqual(["가나다", "다", "나"]);
    expect(marks.showBar(false).showBar).toBe(false);
    expect(marks.clear()).toEqual({ showBar: false, items: [] });
  });

  it("keeps everything across a restart, written whole (no half file, no stray temporary file)", () => {
    const dir = tempDir("wb-bookmarks-"), file = join(dir, "bookmarks.json");
    const first = new BookmarkStore(file);
    first.add({ kind: "item", title: "한림대학교", url: "https://www.hallym.ac.kr/" });
    first.showBar(false);
    expect(new BookmarkStore(file).view()).toEqual(first.view());
    expect(readdirSync(dir)).toEqual(["bookmarks.json"]);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });

  it("a damaged file never stops the gateway: it is set aside and the bookmarks start empty", () => {
    const dir = tempDir("wb-bookmarks-"), file = join(dir, "bookmarks.json");
    writeFileSync(file, "{ half a fi");
    const marks = new BookmarkStore(file);
    expect(marks.view()).toEqual({ showBar: true, items: [] });
    marks.add({ kind: "item", title: "새로", url: "https://new.example/" });
    expect(readdirSync(dir).sort()).toEqual(["bookmarks.json", "bookmarks.json.damaged"]);
    expect(readFileSync(join(dir, "bookmarks.json.damaged"), "utf8")).toBe("{ half a fi");
  });
});

describe("bringing a browser's bookmarks in", () => {
  it("an empty bar becomes the browser's bar (folders kept); its other bookmarks go into 기타 즐겨찾기; one line says what came in", () => {
    const marks = store();
    const result = marks.import("Chrome", BROWSER);
    expect(outline(result.bookmarks.items)).toEqual([
      "한림대학교 → https://www.hallym.ac.kr/",
      "수업/",
      "  스마트캠퍼스 → https://smart.hallym.ac.kr/",
      "  자료/",
      "    RISS → https://www.riss.kr/",
      "기타 즐겨찾기/",
      "  국립국어원 → https://www.korean.go.kr/",
    ]);
    expect([result.items, result.folders, result.message]).toEqual([4, 2, "즐겨찾기 4개, 폴더 2개를 가져왔습니다."]);
  });

  it("a bar that already has items is not overwritten: the import goes into ONE folder named after the browser", () => {
    const marks = store();
    marks.add({ kind: "item", title: "내가 넣은 것", url: "https://mine.example/" });
    const result = marks.import("Firefox", BROWSER);
    expect(outline(result.bookmarks.items)).toEqual([
      "내가 넣은 것 → https://mine.example/",
      "Firefox에서 가져옴/",
      "  한림대학교 → https://www.hallym.ac.kr/",
      "  수업/",
      "    스마트캠퍼스 → https://smart.hallym.ac.kr/",
      "    자료/",
      "      RISS → https://www.riss.kr/",
      "  기타 즐겨찾기/",
      "    국립국어원 → https://www.korean.go.kr/",
    ]);
    expect(result.message).toBe("즐겨찾기 4개, 폴더 2개를 가져왔습니다. 즐겨찾기 줄의 「Firefox에서 가져옴」 폴더에 있습니다.");
  });

  it("the same address already in the same place is not added twice: bringing the same browser in again adds only what is new", () => {
    const marks = store();
    marks.add({ kind: "item", title: "내가 넣은 것", url: "https://mine.example/" });
    marks.import("Chrome", BROWSER);
    const before = outline(marks.view().items);
    const again = marks.import("Chrome", BROWSER);
    expect(outline(again.bookmarks.items)).toEqual(before);
    expect([again.items, again.folders, again.message]).toEqual([0, 0, "새로 가져올 즐겨찾기가 없습니다. 이미 모두 들어 있습니다."]);
    const more = marks.import("Chrome", { bar: [...BROWSER.bar, item("새 사이트", "https://new.example/"), folder("수업", [item("강의계획서", "https://syllabus.example/")])], other: [] });
    expect([more.items, more.folders]).toEqual([2, 0]);
    expect(outline(more.bookmarks.items)).toEqual([
      "내가 넣은 것 → https://mine.example/",
      "Chrome에서 가져옴/",
      "  한림대학교 → https://www.hallym.ac.kr/",
      "  수업/",
      "    스마트캠퍼스 → https://smart.hallym.ac.kr/",
      "    자료/",
      "      RISS → https://www.riss.kr/",
      "    강의계획서 → https://syllabus.example/",
      "  기타 즐겨찾기/",
      "    국립국어원 → https://www.korean.go.kr/",
      "  새 사이트 → https://new.example/",
    ]);
  });

  it("a browser with no bookmarks changes nothing and says so", () => {
    const marks = store();
    const result = marks.import("Edge", { bar: [], other: [] });
    expect([result.bookmarks.items, result.message]).toEqual([[], "Edge에 즐겨찾기가 없습니다."]);
  });
});

describe("/api/bookmarks routes", () => {
  async function gateway() {
    const dir = tempDir("wb-bookmarks-http-"), home = join(dir, "home");
    // A fixture profile in a fixture home: the routes never look at the real one.
    mkdirSync(join(home, ".config/google-chrome/Default"), { recursive: true });
    writeFileSync(join(home, ".config/google-chrome/Default/Bookmarks"), JSON.stringify({ roots: {
      bookmark_bar: { type: "folder", children: [{ type: "url", name: "한림대학교", url: "https://www.hallym.ac.kr/" }, { type: "folder", name: "수업", children: [{ type: "url", name: "스마트캠퍼스", url: "https://smart.hallym.ac.kr/" }] }] },
      other: { type: "folder", children: [{ type: "url", name: "국립국어원", url: "https://www.korean.go.kr/" }] },
    } }));
    const places: BrowserPlaces = { platform: "linux", home, env: {} };
    const bookmarks = new BookmarkStore(join(dir, "data", "bookmarks.json"));
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "data", "works"), dataDir: join(dir, "data") });
    const token = "t";
    const server = createHttpServer(manager, new EventBus(), { token, webDir: null, bookmarks: (req, res, url) => handleBookmarks({ store: bookmarks, places, tempDir: join(dir, "data", "tmp") }, req, res, url) });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanup.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async <T>(method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as T };
    };
    return { dir, base, call };
  }

  it("list, add, rename, move, delete, the bar's switch and 모두 지우기", async () => {
    const { base, call } = await gateway();
    expect((await call<Bookmarks>("GET", "/api/bookmarks")).body).toEqual({ showBar: true, items: [] });
    await call("POST", "/api/bookmarks", { kind: "item", title: "가", url: "https://a.example/" });
    await call("POST", "/api/bookmarks", { kind: "folder", title: "폴더" });
    let view = (await call<Bookmarks>("POST", "/api/bookmarks", { kind: "item", title: "나", url: "https://b.example/" })).body;
    expect(view.items.map((node) => node.title)).toEqual(["가", "폴더", "나"]);
    view = (await call<Bookmarks>("PATCH", `/api/bookmarks/items/${id(view, "가")}`, { title: "가나", url: "https://aa.example/" })).body;
    expect(outline(view.items)[0]).toBe("가나 → https://aa.example/");
    view = (await call<Bookmarks>("POST", `/api/bookmarks/items/${id(view, "나")}/move`, { parentId: null, index: 0 })).body;
    expect(view.items.map((node) => node.title)).toEqual(["나", "가나", "폴더"]);
    view = (await call<Bookmarks>("POST", `/api/bookmarks/items/${id(view, "가나")}/move`, { parentId: id(view, "폴더"), index: 0 })).body;
    expect(outline(view.items)).toEqual(["나 → https://b.example/", "폴더/", "  가나 → https://aa.example/"]);
    view = (await call<Bookmarks>("DELETE", `/api/bookmarks/items/${id(view, "나")}`)).body;
    expect(view.items.map((node) => node.title)).toEqual(["폴더"]);
    expect((await call<Bookmarks>("PUT", "/api/bookmarks/bar", { show: false })).body.showBar).toBe(false);
    const refused = await call<{ code: string }>("POST", "/api/bookmarks", { kind: "item", title: "x", url: "javascript:alert(1)" });
    expect([refused.status, refused.body.code]).toEqual([400, "bookmark_url"]);
    expect((await call<{ code: string }>("PATCH", "/api/bookmarks/items/nowhere", { title: "x" })).status).toBe(404);
    expect((await call<Bookmarks>("DELETE", "/api/bookmarks")).body).toEqual({ showBar: false, items: [] });
    expect((await fetch(`${base}/api/bookmarks`)).status).toBe(401);
  });

  it("the browsers found, and an import from the one named: nothing is read before it is asked for", async () => {
    const { dir, call } = await gateway();
    expect((await call<BookmarkSource[]>("GET", "/api/bookmarks/sources")).body).toEqual([{ id: "chrome", label: "Chrome", profiles: [{ id: "Default", name: "기본 프로필" }] }]);
    expect((await call<Bookmarks>("GET", "/api/bookmarks")).body.items).toEqual([]);
    const result = (await call<BookmarkImportResult>("POST", "/api/bookmarks/import", { source: "chrome", profile: "Default" })).body;
    expect(result.message).toBe("즐겨찾기 3개, 폴더 1개를 가져왔습니다.");
    expect(outline(result.bookmarks.items)).toEqual(["한림대학교 → https://www.hallym.ac.kr/", "수업/", "  스마트캠퍼스 → https://smart.hallym.ac.kr/", "기타 즐겨찾기/", "  국립국어원 → https://www.korean.go.kr/"]);
    const missing = await call<{ code: string; message: string }>("POST", "/api/bookmarks/import", { source: "firefox" });
    expect([missing.status, missing.body.code]).toEqual([404, "bookmark_source"]);
    // No answer names a folder of the person's home.
    expect(missing.body.message).not.toContain(dir);
    expect(existsSync(join(dir, "data", "tmp")) ? readdirSync(join(dir, "data", "tmp")) : []).toEqual([]);
  });
});
