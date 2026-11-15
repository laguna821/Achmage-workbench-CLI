import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { findBookmarkSources, parseChromiumBookmarks, readBrowserBookmarks, readFirefoxBookmarks, type BrowserPlaces, type ImportedNode } from "./bookmark-import.ts";
import { tempDir } from "./test-temp.ts";

// Bringing bookmarks in from a browser (bookmarks unit, 0.5.1). Every file here is a FIXTURE written by
// hand in a temp folder: a Chromium `Bookmarks` JSON, a Firefox `places.sqlite` with the real schema's
// needed columns. No test (and no development run) opens a real browser profile.

/** A tree as `title → url` lines, folders as `title/`, children indented. */
const outline = (nodes: ImportedNode[], depth = 0): string[] => nodes.flatMap((node) => node.kind === "folder"
  ? [`${"  ".repeat(depth)}${node.title}/`, ...outline(node.children, depth + 1)]
  : [`${"  ".repeat(depth)}${node.title} → ${node.url}`]);

const url = (name: string, address: string) => ({ type: "url", name, url: address });
const folder = (name: string, children: unknown[]) => ({ type: "folder", name, children });
const CHROMIUM = {
  checksum: "fixture", version: 1,
  roots: {
    bookmark_bar: folder("북마크바", [
      url("한림대학교", "https://www.hallym.ac.kr/"),
      folder("수업", [
        url("스마트캠퍼스", "https://smart.hallym.ac.kr/"),
        folder("자료", [url("RISS", "https://www.riss.kr/index.do")]),
        folder("빈 폴더", []),
      ]),
      url("한림대학교 (또)", "https://www.hallym.ac.kr/"),
      url("자바스크립트", "javascript:alert(1)"),
      url("설정", "chrome://settings/"),
      url("내 파일", "file:///home/someone/a.html"),
      url("", "https://no-title.example/path"),
      url("암호가 든 주소", "https://user:secret@example.com/"),
      { type: "url", name: "주소 없음" },
      { type: "separator" },
      "not a node",
    ]),
    other: folder("기타 북마크", [url("국립국어원", "https://www.korean.go.kr/")]),
    synced: folder("모바일 북마크", [url("날씨", "https://weather.example/")]),
  },
};

describe("a Chromium profile's Bookmarks file", () => {
  it("gives the bar (folders kept, nested) and the other bookmarks; odd entries and a repeated address are left out", () => {
    const parsed = parseChromiumBookmarks(JSON.stringify(CHROMIUM));
    expect(outline(parsed.bar)).toEqual([
      "한림대학교 → https://www.hallym.ac.kr/",
      "수업/",
      "  스마트캠퍼스 → https://smart.hallym.ac.kr/",
      "  자료/",
      "    RISS → https://www.riss.kr/index.do",
      "  빈 폴더/",
      "no-title.example → https://no-title.example/path",
    ]);
    expect(outline(parsed.other)).toEqual(["국립국어원 → https://www.korean.go.kr/", "날씨 → https://weather.example/"]);
  });

  it("refuses what is not a bookmark file in one plain line, and an empty one is simply empty", () => {
    expect(() => parseChromiumBookmarks("{ not json")).toThrow("즐겨찾기 파일을 읽지 못했습니다");
    expect(() => parseChromiumBookmarks(JSON.stringify({ hello: 1 }))).toThrow("즐겨찾기 파일을 읽지 못했습니다");
    expect(parseChromiumBookmarks(JSON.stringify({ roots: { bookmark_bar: { children: [] } } }))).toEqual({ bar: [], other: [] });
  });
});

/** A places.sqlite with the columns the real schema has for what is read (and one table that must never be read). */
function firefoxFixture(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER, position INTEGER, title LONGVARCHAR, guid TEXT);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
  `);
  const place = db.prepare("INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)");
  const mark = db.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const places: [number, string][] = [
    [1, "https://www.hallym.ac.kr/"], [2, "https://smart.hallym.ac.kr/"], [3, "https://www.riss.kr/"], [4, "place:sort=8&maxResults=10"],
    [5, "https://www.korean.go.kr/"], [6, "https://unfiled.example/"], [7, "https://tagged.example/"], [8, "about:config"], [9, "https://history-only.example/"],
  ];
  for (const [id, address] of places) place.run(id, address, `page ${id}`);
  db.exec("INSERT INTO moz_historyvisits (place_id, visit_date) VALUES (9, 1)");
  // type: 1 bookmark, 2 folder, 3 separator.
  const rows: [number, number, number | null, number, number, string | null, string][] = [
    [1, 2, null, 0, 0, "", "root________"],
    [2, 2, null, 1, 0, "menu", "menu________"],
    [3, 2, null, 1, 1, "toolbar", "toolbar_____"],
    [4, 2, null, 1, 2, "tags", "tags________"],
    [5, 2, null, 1, 3, "unfiled", "unfiled_____"],
    [6, 2, null, 1, 4, "mobile", "mobile______"],
    // The toolbar, out of order on purpose (position decides).
    [11, 2, null, 3, 1, "수업", "folderAAAAAA"],
    [10, 1, 1, 3, 0, "한림대학교", "itemAAAAAAAA"],
    [12, 3, null, 3, 2, null, "separatorAAA"],
    [13, 1, 4, 3, 3, "자주 방문", "queryAAAAAAA"],
    [14, 1, 1, 3, 4, "한림대학교 (또)", "itemBBBBBBBB"],
    [15, 1, 8, 3, 5, "설정", "itemCCCCCCCC"],
    [20, 1, 2, 11, 0, "스마트캠퍼스", "itemDDDDDDDD"],
    [21, 2, null, 11, 1, "자료", "folderBBBBBB"],
    [22, 1, 3, 21, 0, null, "itemEEEEEEEE"],
    // The menu and the unfiled root.
    [30, 1, 5, 2, 0, "국립국어원", "itemFFFFFFFF"],
    [31, 1, 6, 5, 0, "나중에 볼 것", "itemGGGGGGGG"],
    // A tag (never a bookmark of its own).
    [40, 2, null, 4, 0, "태그 이름", "tagAAAAAAAAA"],
    [41, 1, 7, 40, 0, null, "itemHHHHHHHH"],
  ];
  for (const row of rows) mark.run(...row);
  db.close();
}

describe("a Firefox profile's places.sqlite", () => {
  it("reads the toolbar, the menu and the unfiled root from a COPY (separators, tags, place: queries and odd addresses left out), and removes the copy", () => {
    const dir = tempDir("wb-bookmarks-firefox-");
    const profile = join(dir, "profile"), temp = join(dir, "temp");
    mkdirSync(profile); mkdirSync(temp);
    const file = join(profile, "places.sqlite");
    firefoxFixture(file);
    const parsed = readFirefoxBookmarks(file, temp);
    expect(outline(parsed.bar)).toEqual([
      "한림대학교 → https://www.hallym.ac.kr/",
      "수업/",
      "  스마트캠퍼스 → https://smart.hallym.ac.kr/",
      "  자료/",
      "    www.riss.kr → https://www.riss.kr/",
    ]);
    expect(outline(parsed.other)).toEqual(["국립국어원 → https://www.korean.go.kr/", "나중에 볼 것 → https://unfiled.example/"]);
    // Nothing of the history, and nothing left behind.
    expect(JSON.stringify(parsed)).not.toContain("history-only");
    expect(readdirSync(temp)).toEqual([]);
    // The original is as it was (only its own files beside it).
    expect(readdirSync(profile).filter((name) => !name.startsWith("places.sqlite"))).toEqual([]);
  });

  it("reads while Firefox holds the file (another connection has it open and has written to the -wal)", () => {
    const dir = tempDir("wb-bookmarks-firefox-");
    const temp = join(dir, "temp"); mkdirSync(temp);
    const file = join(dir, "places.sqlite");
    firefoxFixture(file);
    const held = new DatabaseSync(file);
    held.exec("BEGIN IMMEDIATE; INSERT INTO moz_places (id, url, title) VALUES (50, 'https://late.example/', 'late'); INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (60, 1, 50, 3, 9, '방금 추가', 'itemLATELATE'); COMMIT; BEGIN IMMEDIATE;");
    try {
      expect(existsSync(`${file}-wal`)).toBe(true);
      expect(outline(readFirefoxBookmarks(file, temp).bar).at(-1)).toBe("방금 추가 → https://late.example/");
    } finally { held.exec("ROLLBACK"); held.close(); }
    expect(readdirSync(temp)).toEqual([]);
  });

  it("says in one line when the file is not a Firefox bookmark store, and still removes its copy", () => {
    const dir = tempDir("wb-bookmarks-firefox-");
    const temp = join(dir, "temp"); mkdirSync(temp);
    const file = join(dir, "places.sqlite");
    writeFileSync(file, "this is not a database");
    expect(() => readFirefoxBookmarks(file, temp)).toThrow("즐겨찾기 파일을 읽지 못했습니다");
    expect(readdirSync(temp)).toEqual([]);
  });
});

describe("the browsers found on this PC (fixture folders only)", () => {
  const chromiumProfile = (root: string, name: string, bookmarks = true) => {
    mkdirSync(join(root, name), { recursive: true });
    if (bookmarks) writeFileSync(join(root, name, "Bookmarks"), JSON.stringify(CHROMIUM));
    // Files that must never be opened: were one read as JSON or SQLite, the import would throw.
    writeFileSync(join(root, name, "Cookies"), "never read");
    writeFileSync(join(root, name, "Login Data"), "never read");
    writeFileSync(join(root, name, "History"), "never read");
  };
  const firefoxRoot = (root: string) => {
    mkdirSync(join(root, "Profiles", "abcd1234.default-release"), { recursive: true });
    mkdirSync(join(root, "Profiles", "efgh5678.empty"), { recursive: true });
    firefoxFixture(join(root, "Profiles", "abcd1234.default-release", "places.sqlite"));
    writeFileSync(join(root, "Profiles", "abcd1234.default-release", "cookies.sqlite"), "never read");
    writeFileSync(join(root, "Profiles", "abcd1234.default-release", "logins.json"), "never read");
    writeFileSync(join(root, "profiles.ini"), [
      "[Install4F96D1932A9F858E]", "Default=Profiles/abcd1234.default-release", "",
      "[Profile1]", "Name=수업용", "IsRelative=1", "Path=Profiles/efgh5678.empty", "",
      "[Profile0]", "Name=default-release", "IsRelative=1", "Path=Profiles/abcd1234.default-release", "Default=1", "",
      "[General]", "StartWithLastProfile=1", "Version=2", "",
    ].join("\n"));
  };

  it("Linux: Chrome and Edge by their folders, each profile that has bookmarks; Firefox by profiles.ini; nothing else listed", () => {
    const home = tempDir("wb-bookmarks-home-");
    chromiumProfile(join(home, ".config/google-chrome"), "Default");
    chromiumProfile(join(home, ".config/google-chrome"), "Profile 2");
    chromiumProfile(join(home, ".config/google-chrome"), "Profile 3", false);
    chromiumProfile(join(home, ".config/google-chrome"), "Guest Profile");
    chromiumProfile(join(home, ".config/microsoft-edge"), "Default");
    mkdirSync(join(home, ".config/chromium"), { recursive: true });
    firefoxRoot(join(home, ".mozilla/firefox"));
    const places: BrowserPlaces = { platform: "linux", home, env: {} };
    const found = findBookmarkSources(places);
    expect(found).toEqual([
      { id: "chrome", label: "Chrome", profiles: [{ id: "Default", name: "기본 프로필" }, { id: "Profile 2", name: "프로필 2" }] },
      { id: "edge", label: "Edge", profiles: [{ id: "Default", name: "기본 프로필" }] },
      { id: "firefox", label: "Firefox", profiles: [{ id: "0:Profile0", name: "default-release" }] },
    ]);
    // Never a path, never the user's name.
    expect(JSON.stringify(found)).not.toContain(home);
  });

  it("reads one named profile: only its bookmark file; an unknown browser or profile is refused", () => {
    const home = tempDir("wb-bookmarks-home-"), temp = tempDir("wb-bookmarks-temp-");
    chromiumProfile(join(home, ".config/google-chrome"), "Default");
    firefoxRoot(join(home, ".mozilla/firefox"));
    const places: BrowserPlaces = { platform: "linux", home, env: {} };
    expect(outline(readBrowserBookmarks(places, "chrome", "Default", temp).parsed.other)).toContain("국립국어원 → https://www.korean.go.kr/");
    expect(readBrowserBookmarks(places, "chrome", undefined, temp).label).toBe("Chrome");
    expect(outline(readBrowserBookmarks(places, "firefox", undefined, temp).parsed.bar)[0]).toBe("한림대학교 → https://www.hallym.ac.kr/");
    expect(() => readBrowserBookmarks(places, "edge", undefined, temp)).toThrow("찾지 못했습니다");
    expect(() => readBrowserBookmarks(places, "chrome", "../../etc", temp)).toThrow("찾지 못했습니다");
    expect(() => readBrowserBookmarks(places, "safari" as never, undefined, temp)).toThrow("찾지 못했습니다");
    expect(readdirSync(temp)).toEqual([]);
  });

  it("Windows and macOS: the same browsers under their own folders (code and fixture folders only)", () => {
    const home = tempDir("wb-bookmarks-home-");
    const local = join(home, "AppData", "Local"), roaming = join(home, "AppData", "Roaming");
    chromiumProfile(join(local, "Google", "Chrome", "User Data"), "Default");
    chromiumProfile(join(local, "Microsoft", "Edge", "User Data"), "Profile 1");
    chromiumProfile(join(local, "Naver", "Naver Whale", "User Data"), "Default");
    firefoxRoot(join(roaming, "Mozilla", "Firefox"));
    expect(findBookmarkSources({ platform: "win32", home, env: { LOCALAPPDATA: local, APPDATA: roaming } }).map((source) => [source.id, source.profiles.map((profile) => profile.id)])).toEqual([
      ["chrome", ["Default"]], ["edge", ["Profile 1"]], ["whale", ["Default"]], ["firefox", ["0:Profile0"]],
    ]);
    const mac = tempDir("wb-bookmarks-home-");
    chromiumProfile(join(mac, "Library/Application Support/Google/Chrome"), "Default");
    chromiumProfile(join(mac, "Library/Application Support/Microsoft Edge"), "Default");
    chromiumProfile(join(mac, "Library/Application Support/BraveSoftware/Brave-Browser"), "Default");
    firefoxRoot(join(mac, "Library/Application Support/Firefox"));
    expect(findBookmarkSources({ platform: "darwin", home: mac, env: {} }).map((source) => source.label)).toEqual(["Chrome", "Edge", "Brave", "Firefox"]);
  });

  it("a PC with no browser gives an empty list", () => {
    expect(findBookmarkSources({ platform: "linux", home: tempDir("wb-bookmarks-home-"), env: {} })).toEqual([]);
  });
});
