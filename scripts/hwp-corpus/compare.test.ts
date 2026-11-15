import { describe, expect, it } from "vitest";
import { compareResults, describeEngines, formatTable, locateDocuments, runExitCode, type CorpusResult, type DocResult, type Manifest } from "./compare.ts";

const chars = () => ({ body: 420, cell: 838, textbox: 12, footnote: 0, endnote: 0, header: 5, footer: 0, memo: 3 });
const structure = () => ({ sections: 1, paragraphs: [12], objects: { cold: 1, secd: 1, tbl: 3, "gso:그림": 2 }, fields: {}, memos: 1, numberings: 1, styles: 20, fonts: ["함초롬돋움", "함초롬바탕"], chars: chars(), textSha256: "a".repeat(64) });
const kinds = () => ({ body: "k1", cell: "k2", textbox: "k3", footnote: "k4", endnote: "k5", header: "k6", footer: "k7", memo: "k8" });
const hashes = () => ({ sha256: "a".repeat(64), digest: "d".repeat(64), kinds: kinds() });
const saved = () => ({ status: "ok" as const, ms: 5, pages: 2, text: { chars: chars(), ...hashes() }, breaks: ["b1", "b2"], differences: [] as string[] });
function doc(id = "a", change: (doc: DocResult) => void = () => {}): DocResult {
  const value: DocResult = {
    id, path: `${id}.hwp`, format: "hwp", status: "ok", ms: 10, pages: 2, lines: [40, 12], paragraphs: [10, 3],
    breaks: ["b1", "b2"], structure: structure(), renderErrors: 0, text: { chars: chars(), ...hashes(), unread: { caption: 1 } },
    firstGlyphs: { count: 3, sha256: "f".repeat(64), xy: [[113.4, 132.3], [126.3, 132.3], [144, 185.9]] },
    save: { none: saved(), append: saved(), other: saved() },
  };
  change(value);
  return value;
}
const result = (...docs: DocResult[]): CorpusResult => ({ schema: 5, engine: { dir: "e", wasmSha256: "x", version: "v" }, codecWasmSha256: "x", startedAt: "t", node: "v", ms: 1, peakRssMb: 1, corpus: { manifestSha256: "m", corpusRoot: true, documents: docs.length, skipped: docs.filter((d) => d.status === "skipped").length }, docs });

describe("corpus comparison", () => {
  it("passes identical results with exit 0", () => {
    const out = compareResults(result(doc("a"), doc("b")), result(doc("a"), doc("b")));
    expect(out.rows.map((row) => row.status)).toEqual(["same", "same"]);
    expect(out.exitCode).toBe(0);
  });

  it("reports a changed page count", () => {
    const out = compareResults(result(doc()), result(doc("a", (d) => { d.pages = 3; d.lines = [40, 10, 2]; })));
    expect(out.rows[0]).toMatchObject({ status: "different" });
    expect(out.rows[0]!.details.join(" ")).toMatch(/쪽 2→3/);
    expect(out.exitCode).toBe(1);
  });

  it("reports a moved line, and ignores sub-pixel noise", () => {
    const moved = compareResults(result(doc()), result(doc("a", (d) => { d.firstGlyphs!.xy[2] = [144, 201.9]; })));
    expect(moved.rows[0]!.status).toBe("different");
    expect(moved.rows[0]!.details.join(" ")).toMatch(/1쪽 3번째 글자 이동.*16/);
    const lines = compareResults(result(doc()), result(doc("a", (d) => { d.lines = [41, 12]; })));
    expect(lines.rows[0]!.details.join(" ")).toMatch(/1쪽 줄 40→41/);
    const noise = compareResults(result(doc()), result(doc("a", (d) => { d.firstGlyphs!.xy[0] = [113.8, 132.0]; })));
    expect(noise.rows[0]!.status).toBe("same");
  });

  it("reports a re-wrapped line on a later page by name, with the same line counts", () => {
    const out = compareResults(result(doc()), result(doc("a", (d) => { d.breaks![1] = "other"; })));
    expect(out.rows[0]!.status).toBe("different");
    expect(out.rows[0]!.details.join(" ")).toMatch(/2쪽 줄 나눔 바뀜/);
    expect(out.exitCode).toBe(1);
  });

  it("reports changed first characters without quoting them", () => {
    const out = compareResults(result(doc()), result(doc("a", (d) => { d.firstGlyphs!.sha256 = "0".repeat(64); })));
    expect(out.rows[0]!.details).toEqual(["1쪽 첫 글자가 바뀜"]);
  });

  it("reports a lost object and a changed font name", () => {
    const lost = compareResults(result(doc()), result(doc("a", (d) => { d.structure!.objects.tbl = 2; })));
    expect(lost.rows[0]!.details.join(" ")).toMatch(/표 3→2/);
    const font = compareResults(result(doc()), result(doc("a", (d) => { d.structure!.fonts = ["함초롬돋움", "HCR Batang"]; })));
    expect(font.rows[0]!.details.join(" ")).toMatch(/글꼴.*함초롬바탕.*HCR Batang/);
    expect(font.exitCode).toBe(1);
  });

  it("reports a save round trip that newly loses something or is refused", () => {
    const out = compareResults(result(doc()), result(doc("a", (d) => { d.save!.append = { status: "refused", ms: 1, code: "hwp_content_loss", message: "표 3→2", differences: [] }; })));
    expect(out.rows[0]!.details.join(" ")).toMatch(/한 글자 저장.*refused/);
    const diff = compareResults(result(doc()), result(doc("a", (d) => { d.save!.none!.differences = ["표 3→2"]; })));
    expect(diff.rows[0]!.details.join(" ")).toMatch(/그대로 저장.*표 3→2/);
    const other = compareResults(result(doc()), result(doc("a", (d) => { d.save!.other = { status: "failed", ms: 1, message: "다시 열지 못함", differences: [] }; })));
    expect(other.rows[0]!.details.join(" ")).toMatch(/다른 형식 저장.*failed/);
    const missing = compareResults(result(doc()), result(doc("a", (d) => { delete d.save!.other; })));
    expect(missing.rows[0]!.details.join(" ")).toMatch(/다른 형식 저장: 결과 없음/);
  });

  it("treats a candidate that lacks a field the baseline has as a difference, never as the same", () => {
    const noBreaks = compareResults(result(doc()), result(doc("a", (d) => { delete d.breaks; })));
    expect(noBreaks.rows[0]).toMatchObject({ status: "different" });
    expect(noBreaks.rows[0]!.details).toContain("줄 나눔 정보 없음");
    expect(noBreaks.exitCode).toBe(1);
    const noText = compareResults(result(doc()), result(doc("a", (d) => { delete d.text; })));
    expect(noText.rows[0]!.details).toContain("글자 정보 없음");
    const saveText = compareResults(result(doc()), result(doc("a", (d) => { delete d.save!.none!.text; delete d.save!.other!.breaks; })));
    expect(saveText.rows[0]!.details).toEqual(["그대로 저장: 다시 연 글자 정보 없음", "다른 형식 저장: 다시 연 줄 나눔 정보 없음"]);
    expect(saveText.exitCode).toBe(1);
  });

  it("reports text lost from one kind of container, and text replaced with the counts unchanged", () => {
    const cells = compareResults(result(doc()), result(doc("a", (d) => { d.text!.chars.cell = 0; d.text!.sha256 = "b".repeat(64); d.text!.digest = "e".repeat(64); d.text!.kinds.cell = "other"; })));
    expect(cells.rows[0]!.details).toEqual(["표 칸 글자 838→0", "글자 내용 바뀜 (표 칸)"]);
    const swapped = compareResults(result(doc()), result(doc("a", (d) => { d.text!.sha256 = "b".repeat(64); d.text!.digest = "e".repeat(64); d.text!.kinds.header = "other"; })));
    expect(swapped.rows[0]!.details).toEqual(["글자 내용 바뀜 (머리말)"]);
    expect(swapped.exitCode).toBe(1);
  });

  // S4: an engine that lists the same containers in another order changes the walking hash only
  it("says when only the order of the text changed, not its content", () => {
    const reordered = compareResults(result(doc()), result(doc("a", (d) => { d.text!.sha256 = "b".repeat(64); d.save!.none!.text!.sha256 = "c".repeat(64); })));
    expect(reordered.rows[0]!.details).toEqual(["글자 순서만 바뀜 — 바뀐 이유를 문서별로 확인", "그대로 저장: 다시 연 글자 순서만 바뀜 — 바뀐 이유를 문서별로 확인"]);
    expect(reordered.exitCode).toBe(1);
    // T2: order only is a difference to explain, never a pass — alone it still exits 1, and the table says so
    const alone = compareResults(result(doc()), result(doc("a", (d) => { d.text!.sha256 = "b".repeat(64); })));
    expect(alone.rows[0]).toMatchObject({ status: "different", details: ["글자 순서만 바뀜 — 바뀐 이유를 문서별로 확인"] });
    expect(alone.exitCode).toBe(1);
    expect(formatTable(alone.rows)).toContain("different  글자 순서만 바뀜 — 바뀐 이유를 문서별로 확인");
  });

  // m2-5: line-break data that is present but empty where the baseline has pages is a difference
  it("treats empty line-break data as a difference when the baseline has line breaks", () => {
    const empty = compareResults(result(doc()), result(doc("a", (d) => { d.breaks = []; d.save!.other!.breaks = []; })));
    expect(empty.rows[0]!.details).toEqual(["줄 나눔 정보 2→0쪽", "다른 형식 저장: 다시 연 줄 나눔 정보 2→0쪽"]);
    expect(empty.exitCode).toBe(1);
  });

  it("reports a drop or a rise of what the engine cannot read", () => {
    const out = compareResults(result(doc()), result(doc("a", (d) => { d.text!.unread = { "header-extra": 1 }; })));
    expect(out.rows[0]!.details).toEqual(["읽지 못하는 개체: 그리기 개체 캡션 1→0", "읽지 못하는 개체: 머리말 (같은 종류 둘째부터) 0→1"]);
  });

  it("reports a save path whose reopened text or line breaks changed between engines", () => {
    const out = compareResults(result(doc()), result(doc("a", (d) => { d.save!.other!.text!.chars.cell = 0; d.save!.none!.breaks![1] = "x"; d.save!.append!.text!.sha256 = "c".repeat(64); d.save!.append!.text!.digest = "c".repeat(64); d.save!.append!.text!.kinds.body = "x"; })));
    expect(out.rows[0]!.details).toEqual(["그대로 저장: 다시 연 2쪽 줄 나눔 바뀜", "한 글자 저장: 다시 연 글자 내용 바뀜 (본문)", "다른 형식 저장: 다시 연 표 칸 글자 838→0"]);
  });

  it("marks a document that stopped opening as failed", () => {
    const out = compareResults(result(doc()), result(doc("a", (d) => { d.status = "failed"; d.reason = "engine panic"; })));
    expect(out.rows[0]).toMatchObject({ status: "failed" });
    expect(out.exitCode).toBe(1);
    const gone = compareResults(result(doc("a")), result());
    expect(gone.rows[0]).toMatchObject({ id: "a", status: "failed" });
  });

  it("treats a missing corpus as a skip, never as a pass", () => {
    const skipped = doc("a", (d) => { d.status = "skipped"; d.reason = "HWP_CORPUS_ROOT is not set"; });
    expect(runExitCode([doc("a"), skipped])).toBe(2);
    expect(runExitCode([doc("a"), skipped, doc("c", (d) => { d.status = "failed"; })])).toBe(1);
    expect(runExitCode([doc("a"), doc("b")])).toBe(0);
    // a save path that failed (its census could not be computed, or the reopened file not read) is loud too
    expect(runExitCode([doc("a"), doc("b", (d) => { d.save = { none: { status: "failed", ms: 1, message: "글자 검사 못함", differences: [] } }; })])).toBe(1);
    const out = compareResults(result(doc("a")), result(skipped));
    expect(out.rows[0]).toMatchObject({ status: "skipped" });
    expect(out.exitCode).toBe(2);
    expect(formatTable(out.rows)).toMatch(/skipped/);
  });

  it("says which engine builds it compared, and warns when both are the same build", () => {
    const base = result(doc()), candidate = result(doc());
    candidate.engine = { dir: "third_party/hop/rhwp-core", wasmSha256: "c".repeat(64), version: "0.9.0" };
    const lines = describeEngines(base, candidate).join("\n");
    expect(lines).toMatch(/기준.*e.*x/);
    expect(lines).toMatch(/후보.*third_party\/hop\/rhwp-core.*c{64}.*0\.9\.0/);
    expect(lines).not.toMatch(/같은 엔진/);
    expect(describeEngines(base, result(doc())).join("\n")).toMatch(/경고: 기준과 후보가 같은 엔진/);
    candidate.codecWasmSha256 = "d".repeat(64);
    expect(describeEngines(base, candidate).join("\n")).toMatch(/저장 단계.*다른 엔진/);
  });

  it("refuses to compare results of different shapes", () => {
    const old = { ...result(doc()), schema: 1 } as unknown as CorpusResult;
    expect(compareResults(old, result(doc())).exitCode).toBe(64);
    // schema 4 counted characters that no writer keeps (T1): its counts mean something else
    expect(compareResults({ ...result(doc()), schema: 4 }, result(doc())).exitCode).toBe(64);
  });

  it("locates repository documents always and corpus documents only under the corpus root", () => {
    const manifest: Manifest = { schema: 1, documents: [
      { id: "own", root: "repo", path: "fixtures/a.hwpx", sha256: "s", size: 1, format: "hwpx", covers: [], source: "", licence: "" },
      { id: "public", root: "corpus", path: "samples/b.hwp", sha256: "s", size: 1, format: "hwp", covers: [], source: "", licence: "" },
    ] };
    const without = locateDocuments(manifest, { repoRoot: "/repo", corpusRoot: undefined });
    expect(without.map((item) => item.file)).toEqual(["/repo/fixtures/a.hwpx", null]);
    expect(without[1]!.skip).toMatch(/HWP_CORPUS_ROOT/);
    expect(locateDocuments(manifest, { repoRoot: "/repo", corpusRoot: undefined, corpusMissing: "HWP_CORPUS_ROOT is not a folder" })[1]!.skip).toBe("HWP_CORPUS_ROOT is not a folder");
    const within = locateDocuments(manifest, { repoRoot: "/repo", corpusRoot: "/corpus" });
    expect(within.map((item) => item.file)).toEqual(["/repo/fixtures/a.hwpx", "/corpus/samples/b.hwp"]);
    expect(() => locateDocuments({ schema: 1, documents: [{ ...manifest.documents[1]!, path: "../escape.hwp" }] }, { repoRoot: "/repo", corpusRoot: "/corpus" })).toThrow();
  });
});
