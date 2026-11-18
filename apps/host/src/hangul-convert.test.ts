import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { EventBus } from "./bus.ts";
import { createHttpServer } from "./http.ts";
import { IeumOffice } from "./ieumoffice.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { tempDir } from "./test-temp.ts";
import {
  ConvertError, GENERAL_DEFAULT_TEMPLATE, IMPORT_PICTURE_FOLDER, IMPORT_TABLE_MODE, PDF_NOT_SHIPPED, SHIP_PDF_EXTENSION, builtinPack,
  coreReadOptions, exportPath, freeImportStem, importOptionsOf, importToMarkdown, markdownToHwpx, withoutFrontMatter,
} from "./hangul-convert.ts";
import { generateWithCore, readWithCore } from "./hanmark/core-fixture.ts";
import { makeKoreanCMapPdf } from "./hanmark/fixtures/koreanCMapPdf.ts";

// 불러오기 / 내보내기 through the app's one kordoc (the bundled core runner, offline) — real runs, no mock
// of the converter. Fixtures: apps/host/src/hanmark/fixtures (README.md).

const FIXTURES = join(import.meta.dirname, "hanmark/fixtures");
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const ieum = new IeumOffice();
/** A real PNG (the core embeds the bytes as they are; a header alone is enough for its checks, but read-back wants a picture). */
function realPng() {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8DwHwyBDAYGAEbmB/mJ5gNBAAAAAElFTkSuQmCC", "base64");
}

function setup() {
  const dir = tempDir("wb-hconv-");
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir, ieum });
  const work = manager.createWork({ title: "특강", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  return { dir, manager, work, convert: manager.hangulConvert };
}

/** A Hangul document made by the core from Markdown: a heading, a footnote, a picture and a table. */
async function sampleHwpx(folder: string, name = "회의 자료.hwpx") {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "pic.png"), realPng());
  const bytes = await generateWithCore("# 회의 자료\n\n첫 문단입니다.[^1]\n\n![그림](pic.png)\n\n| 항목 | 값 |\n| --- | --- |\n| 가 | 1 |\n\n[^1]: 각주 내용\n", { images: { "pic.png": join(folder, "pic.png") } });
  const path = join(folder, name);
  writeFileSync(path, bytes);
  return path;
}

describe("불러오기 options (the four defaults)", () => {
  it("기본 reads tables the readable way (visual), 서식 문서 keeps their structure (keep); the presets stay HanMark's", () => {
    expect(IMPORT_TABLE_MODE.default).toBe("visual");
    expect(IMPORT_TABLE_MODE.form).toBe("keep");
    expect(coreReadOptions(importOptionsOf({}))).toEqual({ layoutTables: "visual" });
    expect(coreReadOptions(importOptionsOf({ preset: "form" }))).toEqual({ keepTrailingEmptyCols: true, includeFieldPlaceholders: true, keepEmptyParagraphs: true, layoutTables: "keep" });
    expect(coreReadOptions(importOptionsOf({ preset: "text" }))).toEqual({ plain: true, images: false, layoutTables: "visual" });
    expect(coreReadOptions(importOptionsOf({ preset: "exam", pages: " 2 - 3 ", images: false }))).toEqual({ tables: false, pages: "2-3", images: false, layoutTables: "visual" });
    expect(() => importOptionsOf({ pages: "3-1" })).toThrow(/쪽 범위/);
    expect(IMPORT_PICTURE_FOLDER("회의 자료")).toBe("회의 자료.assets");
    expect(GENERAL_DEFAULT_TEMPLATE).toBe("builtin:kordoc-default");
    expect(SHIP_PDF_EXTENSION).toBe(false);
  });

  it("finds a free name for the note and its pictures' folder together", () => {
    const taken = new Set(["/p/a.md", "/p/a (1).assets"]);
    expect(freeImportStem("/p", "a", (path) => taken.has(path))).toBe("a (2)");
    expect(freeImportStem("/p", "b:c", () => false)).toBe("b c");
  });
});

describe("불러오기 (HWPX → Markdown)", () => {
  it("writes {stem}.md beside the original with the pictures in {stem}.assets and relative links; the original is untouched", async () => {
    const dir = tempDir("wb-hconv-read-");
    const source = await sampleHwpx(dir);
    const before = sha(readFileSync(source));
    const made = await importToMarkdown(source, dir, importOptionsOf({}));
    expect(made.path).toBe(join(dir, "회의 자료.md"));
    const markdown = readFileSync(made.path, "utf8");
    expect(markdown).toContain("# 회의 자료");
    expect(markdown).toContain("(주: 1) 각주 내용)");
    expect(markdown).toContain("![](<회의 자료.assets/회의 자료-1.png>)");
    expect(made.pictures).toEqual([join(dir, "회의 자료.assets", "회의 자료-1.png")]);
    expect(readFileSync(made.pictures[0])).toEqual(realPng());
    expect(made.tables).toBe(1);
    expect(made.converter).toEqual({ converter: "kordoc", version: "4.18.13", preset: "기본" });
    expect(sha(readFileSync(source))).toBe(before);
    // Again: a free name, never over the first.
    const again = await importToMarkdown(source, dir, importOptionsOf({ images: false }));
    expect(again.path).toBe(join(dir, "회의 자료 (1).md"));
    expect(again.pictures).toEqual([]);
    expect(existsSync(join(dir, "회의 자료 (1).assets"))).toBe(false);
    // A wanted name that is taken is refused, nothing written.
    await expect(importToMarkdown(source, dir, importOptionsOf({}), { name: "회의 자료" })).rejects.toThrow(/이미 있습니다/);
  });

  it("the same input and preset give the same Markdown twice (deterministic, offline)", async () => {
    const dir = tempDir("wb-hconv-same-");
    const source = await sampleHwpx(dir);
    const one = await importToMarkdown(source, join(dir), importOptionsOf({ preset: "form" }));
    const two = await importToMarkdown(source, join(dir), importOptionsOf({ preset: "form" }));
    expect(readFileSync(two.path, "utf8").replaceAll(" (1)", "")).toBe(readFileSync(one.path, "utf8"));
  });

  it("asks for the password of an encrypted HWPX, never passes a wrong one as success, and opens with the right one", async () => {
    const dir = tempDir("wb-hconv-pw-");
    const source = join(dir, "암호 문서.hwpx");
    copyFileSync(join(FIXTURES, "HWP5-password-123456.hwpx"), source);
    const locked = await importToMarkdown(source, dir, importOptionsOf({})).catch((error) => error);
    expect(locked).toBeInstanceOf(ConvertError);
    expect(locked).toMatchObject({ code: "password_required", passwordHelps: true, status: 401 });
    const wrong = await importToMarkdown(source, dir, importOptionsOf({ password: "000000" })).catch((error) => error);
    expect(wrong).toMatchObject({ code: "password_wrong", passwordHelps: true });
    expect(readdirSync(dir)).toEqual(["암호 문서.hwpx"]);
    const opened = await importToMarkdown(source, dir, importOptionsOf({ password: "123456" }));
    expect(readFileSync(opened.path, "utf8")).toContain("안내문");
  });

  it("PDF: not shipped (82 MB > 30 MB) — refused in one plain line, nothing written; the Korean CMap PDF reads once the extension is there", async () => {
    const dir = tempDir("wb-hconv-pdf-");
    const pdf = join(dir, "한글 PDF.pdf");
    writeFileSync(pdf, Buffer.from(makeKoreanCMapPdf()));
    await expect(importToMarkdown(pdf, dir, importOptionsOf({}))).rejects.toThrow(PDF_NOT_SHIPPED);
    expect(readdirSync(dir)).toEqual(["한글 PDF.pdf"]);
    // The flip (SHIP_PDF_EXTENSION): with the folder scripts/fetch-kordoc-pdf.mjs prepares, the core reads it offline.
    const prepared = join(import.meta.dirname, "../../desktop/src-tauri/kordoc-ext");
    if (!existsSync(join(prepared, `${process.platform}-${process.arch}`, "pdf", ".ready"))) return;
    const read = await readWithCore(pdf, {}, { KORDOC_WORKBENCH_CACHE: prepared });
    expect(read.status).not.toBe("failed");
    expect(String(read.data?.markdown)).toContain("한글 PDF");
  });
});

describe("내보내기 (Markdown → HWPX)", () => {
  it("기본: the adapted Markdown through the core; read back; the same bytes twice", async () => {
    const dir = tempDir("wb-hconv-gen-");
    writeFileSync(join(dir, "pic.png"), realPng());
    const text = "---\n상태: 초안\n---\n# 보고\n\n긴 문장이\n이어집니다.[^a]\n\n- [x] 끝냄\n\n> [!note] 알림\n\n![그림](pic.png)\n\n![밖](../밖.png)\n\n[^a]: 각주\n";
    const one = await markdownToHwpx(text, dir, dir, { template: GENERAL_DEFAULT_TEMPLATE });
    const two = await markdownToHwpx(text, dir, dir, { template: GENERAL_DEFAULT_TEMPLATE });
    expect(sha(one.bytes)).toBe(sha(two.bytes));
    expect(one.label).toBe("기본");
    expect(one.warnings.join("\n")).toMatch(/콜아웃/);
    expect(one.warnings.join("\n")).toMatch(/프로젝트 폴더 밖의 그림/);
    const zip = await JSZip.loadAsync(one.bytes);
    expect(Object.keys(zip.files)).toContain("BinData/hanmark_image_001.png");
    for (const entry of Object.values(zip.files)) expect(entry.date.getUTCFullYear()).toBe(1980);
    const file = join(dir, "보고.hwpx"); writeFileSync(file, one.bytes);
    const back = String((await readWithCore(file)).data?.markdown);
    expect(back).toContain("긴 문장이 이어집니다.");
    expect(back).toContain("☑ 끝냄");
    expect(back).toContain("[이미지 누락: 밖]");
    expect(back).not.toContain("상태: 초안");
  });

  it("HanMark's built-in templates (한국언론학회, 청소년학) carry their named styles and fonts; same bytes twice", async () => {
    const dir = tempDir("wb-hconv-style-");
    for (const [template, font] of [["builtin:korean-communication", "신명조"], ["builtin:youth-studies", "휴먼명조"]] as const) {
      const one = await markdownToHwpx("# 제목\n\n본문\n", dir, dir, { template });
      const two = await markdownToHwpx("# 제목\n\n본문\n", dir, dir, { template });
      expect(sha(one.bytes)).toBe(sha(two.bytes));
      const header = await (await JSZip.loadAsync(one.bytes)).file("Contents/header.xml")!.async("text");
      expect(header).toContain(font);
      expect(header).toContain("제목 1");
    }
    const pack = builtinPack("korean-communication", { version: "4.18.13" });
    expect(pack).toMatchObject({ kind: "kordoc-template-pack", name: "한국언론학회" });
  });

  it("HanMark's .hwpx templates register as the person's templates (body font as HanMark reads it) and apply; read back", async () => {
    const { convert } = setup();
    const dir = tempDir("wb-hconv-user-");
    // HanMark tests/documentStyle.test.ts: the five root templates and the body font each must give.
    for (const [name, font] of [["한국언론학회 템플릿.hwpx", "한양신명조"], ["청소년학 템플릿.hwpx", "휴먼명조"], ["방송학회 템플릿.hwpx", "한양신명조"], ["AI융합연구원템플릿.hwpx", "맑은 고딕"]] as const) {
      const registered = await convert.templates.register(join(FIXTURES, name));
      expect(registered.existed).toBe(false);
      expect((await convert.templates.register(join(FIXTURES, name))).existed).toBe(true);
      const pack = JSON.parse(readFileSync(convert.templates.get(registered.id)!.path, "utf8"));
      expect(pack.documentStyle.roles.body.character.fontFamily).toBe(font);
      const made = await markdownToHwpx("# 내 양식\n\n## 소제목\n\n본문 문단\n", dir, dir, { template: `user:${registered.id}`, templates: convert.templates });
      const file = join(dir, `${registered.id}.hwpx`); writeFileSync(file, made.bytes);
      expect(String((await readWithCore(file)).data?.markdown)).toContain("본문 문단");
    }
    expect(convert.templates.choices().filter((choice) => choice.group === "내 양식")).toHaveLength(4);
    // The fifth (blank.hwpx: backslash part names) the core 4.18.13's template-analyze cannot read: refused in words, nothing stored.
    await expect(convert.templates.register(join(FIXTURES, "blank.hwpx"))).rejects.toThrow(/양식을 읽지 못했습니다/);
    expect(convert.templates.list()).toHaveLength(4);
    await expect(convert.templates.register(join(FIXTURES, "koreanCMapPdf.ts"))).rejects.toThrow(/HWPX 파일/);
  });

  it("공문서: a type through the core's preset; one with a cover asks for its date", async () => {
    const dir = tempDir("wb-hconv-gm-");
    const made = await markdownToHwpx("# 사업 보고\n\n> 결과를 공유하고자 함\n\n## 개요\n\n- 내용\n", dir, dir, { template: "gongmun:report" });
    const file = join(dir, "보고.hwpx"); writeFileSync(file, made.bytes);
    expect(String((await readWithCore(file)).data?.markdown)).toContain("사업 보고");
    await expect(markdownToHwpx("# 개조식\n", dir, dir, { template: "gongmun:gaejosik" })).rejects.toThrow(/표지 날짜/);
    const dated = await markdownToHwpx("# 개조식\n\n## 하나\n\n- 내용\n", dir, dir, { template: "gongmun:gaejosik", date: "2026. 11. 18." });
    expect(dated.bytes.length).toBeGreaterThan(1000);
  });

  it("names: a free name beside the source; a wanted name that is taken is refused", () => {
    const dir = tempDir("wb-hconv-name-");
    writeFileSync(join(dir, "보고.hwpx"), "x");
    expect(exportPath(dir, "보고", "hwpx")).toBe(join(dir, "보고 (1).hwpx"));
    expect(() => exportPath(dir, "보고", "hwpx", "보고")).toThrow(/이미 있습니다/);
    expect(exportPath(dir, "보고", "hwp", "새 이름.hwp")).toBe(join(dir, "새 이름.hwp"));
    expect(withoutFrontMatter("---\na: 1\n---\n# 본문\n")).toBe("# 본문\n");
  });
});

describe("the gateway's routes (listed documents, projects, refusals)", () => {
  it("불러오기 a listed .hwpx: a new document with derivedFrom + convertedFrom (no front matter); the original kept and listed", async () => {
    const { manager, work, convert } = setup();
    const source = await sampleHwpx(work.cwd);
    const original = manager.openFile(work.id, source);
    const result = await convert.convertDocument(original.id, { preset: "default" });
    expect(result.artifact.name).toBe("회의 자료.md");
    expect(result).toMatchObject({ pictures: 1, tables: 1 });
    const [revision] = manager.documents.revisions(result.artifact.id);
    expect(revision.derivedFrom).toEqual([{ artifactId: original.id, revision: original.revision }]);
    expect(revision.convertedFrom).toEqual({ converter: "kordoc", version: "4.18.13", preset: "기본" });
    expect(revision.note).toContain("「회의 자료.hwpx」에서 불러옴");
    expect(readFileSync(result.artifact.path, "utf8").startsWith("---")).toBe(false);
    expect(manager.documents.get(original.id).sha256).toBe(original.sha256);
  });

  it("문서 불러오기… copies a file from elsewhere into the project folder (never moves it) and lists it; a dropped file the same", () => {
    const { manager, work, convert } = setup();
    const elsewhere = tempDir("wb-hconv-else-");
    const outside = join(elsewhere, "받은 문서.hwpx");
    copyFileSync(join(FIXTURES, "blank.hwpx"), outside);
    const [entry] = convert.importFiles(work.id, [outside]);
    expect(entry.path).toBe(join(work.cwd, "받은 문서.hwpx"));
    expect(existsSync(outside)).toBe(true);
    expect(manager.documents.get(entry.artifactId!).name).toBe("받은 문서.hwpx");
    const dropped = convert.importUpload(work.id, "받은 문서.hwpx", readFileSync(outside));
    expect(dropped.name).toBe("받은 문서 (1).hwpx");
    const xls = convert.importUpload(work.id, "표.xls", Buffer.from("x"));
    expect(xls.artifactId).toBeNull();
    expect(() => convert.importUpload(work.id, "그림.png", Buffer.from("x"))).toThrow(/불러올 수 없는 형식/);
    expect(() => convert.importFiles(work.id, ["relative.hwpx"])).toThrow();
  });

  it("refuses: a file outside the project, a taken name, a removed document", async () => {
    const { manager, work, convert } = setup();
    const elsewhere = tempDir("wb-hconv-out-");
    const outside = await sampleHwpx(elsewhere, "밖.hwpx");
    // A file of the person's disk that is not in the project folder (not imported): refused; 문서 불러오기… copies it in.
    await expect(convert.convertFile(work.id, outside, {})).rejects.toMatchObject({ code: "outside_project" });
    expect(readdirSync(elsewhere).sort()).toEqual(["pic.png", "밖.hwpx"]);
    const note = join(work.cwd, "보고.md"); writeFileSync(note, "# 보고\n\n본문\n");
    writeFileSync(join(work.cwd, "있음.hwpx"), "taken");
    const md = manager.openFile(work.id, note);
    await expect(convert.exportDocument(md.id, { format: "hwpx", name: "있음" })).rejects.toMatchObject({ code: "export_name_taken" });
    expect(readFileSync(join(work.cwd, "있음.hwpx"), "utf8")).toBe("taken");
    manager.removeDocument(md.id, { action: "unlisted" });
    await expect(convert.exportDocument(md.id, {})).rejects.toMatchObject({ code: "document_removed" });
  });

  it("내보내기 HWPX and HWP: new documents beside the source, linked to it; the .hwp passes the save checks and reads back", async () => {
    const { manager, work, convert } = setup();
    const note = join(work.cwd, "주간 보고.md"); writeFileSync(note, "# 주간 보고\n\n이번 주 한 일입니다.\n\n| 요일 | 일 |\n| --- | --- |\n| 월 | 회의 |\n");
    const md = manager.openFile(work.id, note);
    const hwpx = await convert.exportDocument(md.id, { format: "hwpx", template: "builtin:youth-studies" });
    expect(hwpx.artifact.name).toBe("주간 보고.hwpx");
    expect(hwpx.template).toBe("청소년학");
    expect(manager.documents.revisions(hwpx.artifact.id)[0]).toMatchObject({ derivedFrom: [{ artifactId: md.id, revision: md.revision }], convertedFrom: { converter: "kordoc", preset: "청소년학" } });
    expect(String((await readWithCore(hwpx.artifact.path)).data?.markdown)).toContain("이번 주 한 일입니다.");
    const hwp = await convert.exportDocument(md.id, { format: "hwp" });
    expect(hwp.artifact.name).toBe("주간 보고.hwp");
    const bytes = readFileSync(hwp.artifact.path);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("d0cf11e0");
    expect(hwp.check?.structure).toBe("checked");
    expect(String((await readWithCore(hwp.artifact.path)).data?.markdown)).toContain("이번 주 한 일입니다.");
    // Again: never over the first.
    expect((await convert.exportDocument(md.id, { format: "hwpx" })).artifact.name).toBe("주간 보고 (1).hwpx");
    expect(readFileSync(note, "utf8")).toContain("# 주간 보고");
  }, 120_000);

  it.runIf(ieum.available)("내보내기 DOCX: the Ieum CLI's md → docx, a new document beside the source; read back", async () => {
    const { manager, work, convert } = setup();
    const note = join(work.cwd, "안내.md"); writeFileSync(note, "# 안내\n\n워드로 내보내는 문단\n");
    const md = manager.openFile(work.id, note);
    const docx = await convert.exportDocument(md.id, { format: "docx" });
    expect(docx.artifact.name).toBe("안내.docx");
    expect(await ieum.textView(docx.artifact.path, "docx")).toContain("워드로 내보내는 문단");
  }, 120_000);
});

describe("the routes over HTTP", () => {
  it("choices, 문서 불러오기 (copy in), a password asked in the answer, convert, export, refusals with their codes", async () => {
    const { manager, work } = setup();
    const server = createHttpServer(manager, new EventBus(), { token: "t", webDir: null });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer t", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    try {
      const choices = await call("GET", "/api/hangul-convert/choices");
      expect(choices.body.presets.map((preset: { label: string }) => preset.label)).toEqual(["기본 (권장)", "글 위주", "서식 문서", "시험지·안내문 PDF"]);
      expect(choices.body.templates.slice(0, 3).map((entry: { label: string }) => entry.label)).toEqual(["기본", "한국언론학회", "청소년학"]);
      expect(choices.body).toMatchObject({ defaultTemplate: "builtin:kordoc-default", pdf: false, converter: "kordoc 4.18.13" });
      const elsewhere = tempDir("wb-hconv-http-");
      const locked = join(elsewhere, "암호.hwpx"); copyFileSync(join(FIXTURES, "HWP5-password-123456.hwpx"), locked);
      const imported = await call("POST", `/api/works/${work.id}/import-documents`, { paths: [locked] });
      const [file] = imported.body.files;
      expect(file.path).toBe(join(work.cwd, "암호.hwpx"));
      const asked = await call("POST", `/api/artifacts/${file.artifactId}/convert-to-markdown`, {});
      expect(asked).toMatchObject({ status: 401, body: { code: "password_required", passwordHelps: true } });
      const opened = await call("POST", `/api/artifacts/${file.artifactId}/convert-to-markdown`, { password: "123456" });
      expect(opened.body.artifact.name).toBe("암호.md");
      const exported = await call("POST", `/api/artifacts/${opened.body.artifact.id}/export-hangul`, { format: "hwpx", template: "builtin:korean-communication" });
      expect(exported.body).toMatchObject({ artifact: { name: "암호.hwpx".replace(".hwpx", " (1).hwpx") }, template: "한국언론학회" });
      const dropped = await call("POST", `/api/works/${work.id}/import-upload`, readFileSync(join(FIXTURES, "blank.hwpx")), { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("끌어온 문서.hwpx") });
      expect(dropped.body.files[0].name).toBe("끌어온 문서.hwpx");
      expect((await call("POST", `/api/works/${work.id}/convert-to-markdown`, { path: locked })).body.code).toBe("outside_project");
      expect((await call("POST", `/api/artifacts/${opened.body.artifact.id}/export-hangul`, { name: "암호" })).body.code).toBe("export_name_taken");
      expect((await call("POST", `/api/artifacts/${opened.body.artifact.id}/export-hangul`, { format: "pdf" })).status).toBe(400);
    } finally { await new Promise((done) => server.close(done)); }
  }, 120_000);
});

