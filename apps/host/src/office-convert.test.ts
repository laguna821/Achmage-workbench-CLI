import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/engine.ts";
import { hwpWasmPath } from "./hwp-resource.ts";
import { convertLegacy, docLosses, legacyLine, lossLedger, wordToHangul, xlsxWasmPath } from "./office-convert.ts";
import { runConvertJob } from "./office-convert-work.mjs";
import { EventBus } from "./bus.ts";
import { IEUM_CONVERTERS } from "./hangul-convert.ts";
import { createHttpServer } from "./http.ts";
import { IeumOffice } from "./ieumoffice.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { tempDir } from "./test-temp.ts";

// The conversions IeumOffice v0.13.0 brought, on upstream's own fixtures, run for real (no mock of a converter):
// docx2hwp on Workbench's one Hangul engine, doc2docx, ppt2pptx, and the xlsx engine's WebAssembly through WASI.

const VENDOR = join(import.meta.dirname, "../../../vendor/ieumoffice");
const DOCX = (name: string) => readFileSync(join(VENDOR, "packages/docx2hwp/tests/fixtures", name));
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const inProcess = runConvertJob;

/** A minimal ODS package the way the xlsx engine's own tests write one (convert.rs write_ods_fixture). */
export async function sampleOds() {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"';
  const body = '<table:table table:name="성적"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell office:value-type="string"><text:p>이름</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell office:value-type="string"><text:p>합계</text:p></table:table-cell><table:table-cell table:formula="of:=[.B1]*2" office:value-type="float" office:value="84"><text:p>84</text:p></table:table-cell></table:table-row></table:table>';
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet", { compression: "STORE" });
  zip.file("content.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.2"><office:automatic-styles/><office:body><office:spreadsheet>${body}</office:spreadsheet></office:body></office:document-content>`);
  zip.file("styles.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.2"><office:styles/><office:automatic-styles/><office:master-styles/></office:document-styles>`);
  zip.file("META-INF/manifest.xml", '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function pagesOf(bytes: Uint8Array) {
  await init({ module_or_path: readFileSync(hwpWasmPath()) });
  const doc = new HwpDocument(bytes);
  try { return doc.pageCount(); } finally { doc.free(); }
}

describe("Word → Hangul (docx2hwp on the one engine)", () => {
  it("makes an .hwpx the engine opens again, with the ledger of what changes", async () => {
    const made = await wordToHangul(DOCX("notice.docx"), "hwpx", inProcess);
    expect(Buffer.from(made.bytes.subarray(0, 2)).toString()).toBe("PK");
    expect(await pagesOf(made.bytes)).toBeGreaterThan(0);
    expect(Array.isArray(made.losses)).toBe(true);
  }, 120_000);

  it("writes a .hwp only when the engine reads it back with the same page count (upstream's rule)", async () => {
    for (const name of ["notice.docx", "nested.docx", "markdown-tables.docx"]) {
      const hwpx = await wordToHangul(DOCX(name), "hwpx", inProcess);
      let hwp: Awaited<ReturnType<typeof wordToHangul>> | null = null;
      try { hwp = await wordToHangul(DOCX(name), "hwp", inProcess); }
      catch (error) { expect((error as { code?: string }).code).toBe("hwp_readback"); continue; }
      // the OLE2 signature of a .hwp, and the same pages as the .hwpx copy
      expect(sha(hwp.bytes.subarray(0, 8))).toBe(sha(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])));
      expect(await pagesOf(hwp.bytes)).toBe(await pagesOf(hwpx.bytes));
    }
  }, 240_000);

  it("is deterministic: the same Word document gives the same bytes", async () => {
    const one = await wordToHangul(DOCX("tabs.docx"), "hwpx", inProcess);
    const two = await wordToHangul(DOCX("tabs.docx"), "hwpx", inProcess);
    expect(sha(one.bytes)).toBe(sha(two.bytes));
    const hwp1 = await wordToHangul(DOCX("tabs.docx"), "hwp", inProcess);
    const hwp2 = await wordToHangul(DOCX("tabs.docx"), "hwp", inProcess);
    expect(sha(hwp1.bytes)).toBe(sha(hwp2.bytes));
  }, 240_000);

  it("refuses bytes that are not a Word document, in words", async () => {
    await expect(wordToHangul(Buffer.from("not a docx"), "hwpx", inProcess)).rejects.toMatchObject({ code: "not_docx" });
  }, 60_000);

  it("says the ledger in upstream's Korean words", () => {
    const ledger = lossLedger([{ feature: "comment", kind: "dropped", count: 2 }, { feature: "hyperlink", kind: "changed", count: 1 }], true);
    expect(ledger.title).toBe("한글 문서로 내보내기");
    expect(ledger.message).toBe("한글 문서에서는 일부 내용이 바뀌거나 빠집니다.");
    expect(ledger.sections).toEqual([
      { heading: "바뀌는 것", items: ["하이퍼링크(글로만 남음)"] },
      { heading: "빠지는 것", items: ["메모 (2)", "암호"] },
    ]);
    expect(lossLedger([]).sections).toEqual([]);
    expect(hwpWasmPath()).toMatch(/rhwp_bg\.wasm$|\.wasm$/);
  });
});

describe("변환해서 열기 (.doc, .ppt, .ods; old .xls)", () => {
  it(".doc → .docx (doc2docx), with what it reports in one line", async () => {
    const source = readFileSync(join(VENDOR, "packages/doc2docx/tests/fixtures/table.doc"));
    const { bytes, reply } = await convertLegacy("doc", source, inProcess);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file("word/document.xml")).not.toBeNull();
    expect(await zip.file("word/document.xml")!.async("string")).toContain("<w:tbl>");
    expect(legacyLine("doc", "회의록.doc", reply as never)).toMatch(/^DOCX 사본으로 열었습니다\. .+ 원본 「회의록\.doc」은 그대로 둡니다\.$/);
    const again = await convertLegacy("doc", source, inProcess);
    expect(sha(again.bytes)).toBe(sha(bytes));
  }, 60_000);

  it("names what a .doc loses as a person recognizes it", () => {
    expect(docLosses(["images are not converted yet; image placeholders are omitted", "a JPEG picture is truncated; the available data was kept", "headers are not converted yet; their text is omitted"]))
      .toEqual(["그림 일부", "머리말·꼬리말 일부"]);
    expect(docLosses(["the file is already Office Open XML; it was kept as is"])).toEqual([]);
  });

  it(".ppt → .pptx (ppt2pptx): notes and animations said not to carry", async () => {
    const source = readFileSync(join(VENDOR, "packages/file-parse/tests/fixtures/legacy-sample.ppt"));
    const { bytes, reply } = await convertLegacy("ppt", source, inProcess);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).some((name) => /^ppt\/slides\/slide1\.xml$/.test(name))).toBe(true);
    expect(legacyLine("ppt", "강의.ppt", reply as never)).toContain("슬라이드 노트·애니메이션은 옮기지 않았습니다.");
    const again = await convertLegacy("ppt", source, inProcess);
    // ppt2pptx writes its zip with fixed dates: say so if it does not
    expect(sha(again.bytes)).toBe(sha(bytes));
  }, 60_000);

  it.skipIf(!xlsxWasmPath())(".ods → .xlsx on the xlsx engine's WebAssembly (WASI): values and formulas", async () => {
    const { bytes, reply } = await convertLegacy("ods", await sampleOds(), inProcess);
    const sheet = await (await JSZip.loadAsync(bytes)).file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain("이름");
    expect(sheet).toContain("<f>B1*2</f>");
    expect(legacyLine("ods", "성적.ods", reply as never)).toContain("수식과 값은 모두 옮겼습니다.");
    expect(legacyLine("ods", "성적.ods", { ok: true, formulasDropped: 3 })).toContain("수식 3개는 옮기지 못해 계산된 값만 남겼습니다.");
  }, 60_000);

  it.skipIf(!xlsxWasmPath())("old .xls: v0.13.0's import carries pictures and merges", async () => {
    const source = readFileSync(join(VENDOR, "apps/sheets/native/xlsx-engine/tests/fixtures/merges-widths-picture.xls"));
    const { bytes } = await convertLegacy("xls", source, inProcess);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toContain("xl/media/image1.png");
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).toContain("<mergeCell");
  }, 60_000);

  it("refuses a file that is not what its name says, in words", async () => {
    await expect(convertLegacy("ppt", Buffer.from("plain text"), inProcess)).rejects.toMatchObject({ code: "legacy_unreadable" });
    await expect(convertLegacy("doc", Buffer.from("plain text"), inProcess)).rejects.toMatchObject({ code: "legacy_unreadable" });
  }, 60_000);
});

function setup() {
  const dir = tempDir("wb-conv2-");
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir, ieum: new IeumOffice(null) });
  const work = manager.createWork({ title: "특강", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  return { dir, manager, work, convert: manager.hangulConvert };
}

describe("the gateway's side (listed documents, inside the project, never over a file)", () => {
  it("names the IeumOffice release whose converters run (the pin)", () => {
    const pinned = readFileSync(join(VENDOR, "../ieumoffice.PINNED"), "utf8").match(/^release: v(.+)$/m)?.[1];
    expect(IEUM_CONVERTERS).toBe(`IeumOffice ${pinned}`);
  });

  it("lists .doc / .ppt / .ods as documents of their own kind, and never reads them as text", async () => {
    const { manager, work } = setup();
    const path = join(work.cwd, "옛 강의.ppt");
    writeFileSync(path, readFileSync(join(VENDOR, "packages/file-parse/tests/fixtures/legacy-sample.ppt")));
    const listed = manager.openFile(work.id, path);
    expect(listed.format).toBe("ppt");
    await expect(manager.documents.text(listed.id)).rejects.toMatchObject({ code: "legacy_document" });
  });

  it("변환해서 열기: {stem}.pptx / .docx / .xlsx beside the original (a free name when taken), linked to it; the original untouched", async () => {
    const { manager, work, convert } = setup();
    const ppt = join(work.cwd, "옛 강의.ppt");
    writeFileSync(ppt, readFileSync(join(VENDOR, "packages/file-parse/tests/fixtures/legacy-sample.ppt")));
    const before = sha(readFileSync(ppt));
    const original = manager.openFile(work.id, ppt);
    const first = await convert.openConverted(original.id);
    expect(first.artifact).toMatchObject({ name: "옛 강의.pptx", format: "pptx" });
    expect(first.line).toContain("슬라이드 노트·애니메이션은 옮기지 않았습니다.");
    const [revision] = manager.documents.revisions(first.artifact.id);
    expect(revision.derivedFrom).toEqual([{ artifactId: original.id, revision: original.revision }]);
    expect(revision.convertedFrom).toEqual({ converter: "ppt2pptx", version: IEUM_CONVERTERS, preset: "변환해서 열기" });
    // Again: never over the first copy.
    expect((await convert.openConverted(original.id)).artifact.name).toBe("옛 강의 (1).pptx");
    expect(sha(readFileSync(ppt))).toBe(before);

    const doc = join(work.cwd, "회의록.doc");
    writeFileSync(doc, readFileSync(join(VENDOR, "packages/doc2docx/tests/fixtures/rich.doc")));
    writeFileSync(join(work.cwd, "회의록.docx"), "taken");
    const word = await convert.openConverted(manager.openFile(work.id, doc).id);
    expect(word.artifact.name).toBe("회의록 (1).docx");
    expect(readFileSync(join(work.cwd, "회의록.docx"), "utf8")).toBe("taken");
    expect(manager.documents.revisions(word.artifact.id)[0].convertedFrom?.converter).toBe("doc2docx");

    if (xlsxWasmPath()) {
      const ods = join(work.cwd, "성적.ods");
      writeFileSync(ods, await sampleOds());
      const sheet = await convert.openConverted(manager.openFile(work.id, ods).id);
      expect(sheet.artifact).toMatchObject({ name: "성적.xlsx", format: "xlsx" });
      expect(sheet.line).toBe("XLSX 사본으로 열었습니다. 수식과 값은 모두 옮겼습니다. 원본 「성적.ods」은 그대로 둡니다.");
    }
  }, 120_000);

  it("refuses: another format, a removed document; a file opened from elsewhere (its own workspace of the project, as for 불러오기) gets its copy beside it", async () => {
    const { manager, work, convert } = setup();
    const note = join(work.cwd, "보고.md"); writeFileSync(note, "# 보고\n");
    await expect(convert.openConverted(manager.openFile(work.id, note).id)).rejects.toMatchObject({ code: "convert_format" });
    const elsewhere = tempDir("wb-conv2-out-");
    const outside = join(elsewhere, "밖.ppt"); writeFileSync(outside, readFileSync(join(VENDOR, "packages/file-parse/tests/fixtures/legacy-sample.ppt")));
    expect((await convert.openConverted(manager.openFile(work.id, outside).id)).artifact.path).toBe(join(elsewhere, "밖.pptx"));
    const inside = join(work.cwd, "안.ppt"); writeFileSync(inside, readFileSync(outside));
    const listed = manager.openFile(work.id, inside);
    manager.removeDocument(listed.id, { action: "unlisted" });
    await expect(convert.openConverted(listed.id)).rejects.toMatchObject({ code: "document_removed" });
    expect(existsSync(join(work.cwd, "안.pptx"))).toBe(false);
  }, 60_000);

  it("Word → Hangul: the ledger first, nothing written; 저장 writes a NEW .hwpx beside the Word document, linked to it", async () => {
    const { manager, work, convert } = setup();
    const path = join(work.cwd, "가정통신문.docx");
    writeFileSync(path, DOCX("notice.docx"));
    const word = manager.openFile(work.id, path);
    const plan = await convert.prepareWordHangul(word.id, {});
    expect(plan).toMatchObject({ format: "hwpx", name: "가정통신문.hwpx" });
    expect(plan.ledger.message).toBe("한글 문서에서는 일부 내용이 바뀌거나 빠집니다.");
    expect(existsSync(join(work.cwd, "가정통신문.hwpx"))).toBe(false);
    const saved = await convert.commitWordHangul(word.id, plan.ticket);
    expect(saved.artifact).toMatchObject({ name: "가정통신문.hwpx", format: "hwpx" });
    const [revision] = manager.documents.revisions(saved.artifact.id);
    expect(revision.derivedFrom).toEqual([{ artifactId: word.id, revision: word.revision }]);
    expect(revision.convertedFrom).toEqual({ converter: "docx2hwp", version: IEUM_CONVERTERS, preset: "워드 모양 · HWPX" });
    expect(await pagesOf(readFileSync(saved.artifact.path))).toBeGreaterThan(0);
    // A ticket answers once.
    await expect(convert.commitWordHangul(word.id, plan.ticket)).rejects.toMatchObject({ code: "export_expired" });
    // Again: a free name; a wanted name already taken is refused before converting.
    const again = await convert.prepareWordHangul(word.id, { format: "hwp" });
    expect(again.name).toBe("가정통신문.hwp");
    await expect(convert.prepareWordHangul(word.id, { name: "가정통신문" })).rejects.toMatchObject({ code: "export_name_taken" });
    // A password the Word document carries is said to go.
    const locked = await convert.prepareWordHangul(word.id, { passwordSet: true });
    expect(locked.ledger.sections.at(-1)).toMatchObject({ heading: "빠지는 것" });
    expect(locked.ledger.sections.at(-1)!.items).toContain("암호");
    expect(readFileSync(path)).toEqual(DOCX("notice.docx"));
  }, 180_000);

  it("only a Word document; a removed one is refused", async () => {
    const { manager, work, convert } = setup();
    const note = join(work.cwd, "보고.md"); writeFileSync(note, "# 보고\n");
    await expect(convert.prepareWordHangul(manager.openFile(work.id, note).id, {})).rejects.toMatchObject({ code: "export_source" });
  });

  it("over HTTP: the Word editor's own bytes (octet-stream), commit, open-converted", async () => {
    const { manager, work } = setup();
    const server = createHttpServer(manager, new EventBus(), { token: "t", webDir: null });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer t", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    try {
      const path = join(work.cwd, "표 문서.docx");
      writeFileSync(path, DOCX("nested.docx"));
      const word = manager.openFile(work.id, path);
      // The editor's document as it is open (here: another document's bytes) is what gets converted.
      const plan = await call("POST", `/api/artifacts/${word.id}/word-to-hangul?format=hwpx&name=${encodeURIComponent("편집본")}`, DOCX("tabs.docx"), { "content-type": "application/octet-stream" });
      expect(plan.body).toMatchObject({ format: "hwpx", name: "편집본.hwpx" });
      const saved = await call("POST", `/api/artifacts/${word.id}/word-to-hangul/commit`, { ticket: plan.body.ticket });
      expect(saved.body.artifact.name).toBe("편집본.hwpx");
      expect(manager.documents.revisions(saved.body.artifact.id)[0].note).toContain("(편집 중이던 내용)에서 내보냄");
      const listed = await call("POST", `/api/artifacts/${word.id}/word-to-hangul`, { format: "pdf" });
      expect(listed.status).toBe(400);
      const ppt = join(work.cwd, "발표.ppt"); writeFileSync(ppt, readFileSync(join(VENDOR, "packages/file-parse/tests/fixtures/legacy-sample.ppt")));
      const opened = await call("POST", `/api/artifacts/${manager.openFile(work.id, ppt).id}/open-converted`, {});
      expect(opened.body.artifact.name).toBe("발표.pptx");
      expect(opened.body.line).toBe("PPTX 사본으로 열었습니다. 슬라이드 노트·애니메이션은 옮기지 않았습니다. 원본 「발표.ppt」은 그대로 둡니다.");
    } finally { await new Promise((done) => server.close(done)); }
  }, 180_000);
});
