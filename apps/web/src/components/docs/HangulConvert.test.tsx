// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import { ApiRequestError, type Api, type HangulChoices } from "../../api.ts";
import { HangulImportDialog } from "./HangulImportDialog.tsx";
import { HangulExportDialog, todayDot } from "./HangulExportDialog.tsx";
import { InsideSection } from "../nav/InsideSection.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CHOICES: HangulChoices = {
  presets: [
    { id: "default", label: "기본 (권장)", description: "원본 구조를 그대로 옮깁니다. 대부분의 문서에 알맞습니다." },
    { id: "text", label: "글 위주", description: "글만" }, { id: "form", label: "서식 문서", description: "양식" }, { id: "exam", label: "시험지·안내문 PDF", description: "PDF" },
  ],
  templates: [
    { id: "builtin:kordoc-default", label: "기본", group: "기본 서식" }, { id: "builtin:korean-communication", label: "한국언론학회", group: "기본 서식" },
    { id: "builtin:youth-studies", label: "청소년학", group: "기본 서식" }, { id: "gongmun:gaejosik", label: "정부 표준 개조식", group: "공문서" },
  ],
  defaultTemplate: "builtin:kordoc-default", pdf: false, pdfLine: "PDF 불러오기는 이 버전에 들어 있지 않습니다.", converter: "kordoc 4.18.13",
};
const doc = (name: string, format: Artifact["format"], id = "a1") => ({ id, workId: "w", path: `/w/${name}`, name, format, revision: 1, sha256: "", size: 1, diskState: "same", readBy: {}, createdAt: 0, updatedAt: 0 }) as Artifact;
const converted = (name: string, warnings: string[] = []) => ({ artifact: doc(name, "markdown", `md-${name}`), pictures: 2, tables: 1, warnings, fileType: "hwpx" });
const encrypted = (message: string) => new ApiRequestError(401, { code: "password_required", message, passwordHelps: true } as never);
const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });

it("불러오기: HanMark's four presets, 쪽 범위, 그림 저장; a clean single file just opens its new document", async () => {
  const convertToMarkdown = vi.fn(async () => converted("회의.md"));
  const api = { hangulChoices: async () => CHOICES, convertToMarkdown } as unknown as Api;
  const onOpen = vi.fn(), onClose = vi.fn();
  render(<HangulImportDialog api={api} target={{ workId: "w", files: [{ path: "/w/회의.hwpx", name: "회의.hwpx", artifactId: "h1" }] }} onOpen={onOpen} onClose={onClose} />);
  await flush();
  expect(screen.getByRole("dialog", { name: "「회의.hwpx」 Markdown 문서로 변환" })).toBeTruthy();
  expect(screen.getByText("원본 구조를 그대로 옮깁니다. 대부분의 문서에 알맞습니다.")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "쪽 범위" }), { target: { value: "1-3" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "그림을 파일로 저장" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "변환" })); });
  expect(convertToMarkdown).toHaveBeenCalledWith({ artifactId: "h1" }, { preset: "default", pages: "1-3", images: false });
  expect(onOpen).toHaveBeenCalledWith("md-회의.md");
  expect(onClose).toHaveBeenCalled();
});

it("불러오기: asks for a password (memory only), three tries at most, then reports; PDF said in one line and skipped", async () => {
  const convertToMarkdown = vi.fn(async (target: { artifactId?: string; path?: string }, options: { password?: string }) => {
    if (target.artifactId === "pw" && options.password !== "123456") throw encrypted(options.password ? "암호가 맞지 않습니다." : "암호가 걸린 문서입니다.");
    if (target.artifactId === "pw2") throw encrypted(options.password ? "암호가 맞지 않습니다." : "암호가 걸린 문서입니다.");
    return converted(`${target.artifactId ?? "표"}.md`, ["3쪽: 삽입된 개체(OLE)는 가져오지 않았습니다."]);
  });
  const api = { hangulChoices: async () => CHOICES, convertToMarkdown } as unknown as Api;
  const onOpen = vi.fn();
  render(<HangulImportDialog api={api} target={{ workId: "w", files: [
    { path: "/w/a.hwpx", name: "a.hwpx", artifactId: "pw" }, { path: "/w/b.hwpx", name: "b.hwpx", artifactId: "pw2" },
    { path: "/w/c.pdf", name: "c.pdf", artifactId: "pdf" }, { path: "/w/표.xls", name: "표.xls", artifactId: null },
  ] }} onOpen={onOpen} onClose={vi.fn()} />);
  await flush();
  expect(screen.getByText("PDF 불러오기는 이 버전에 들어 있지 않습니다.")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "변환" })); });
  const field = screen.getByLabelText("문서 암호") as HTMLInputElement;
  expect(field.type).toBe("password");
  fireEvent.change(field, { target: { value: "123456" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "암호로 열기" })); });
  // The second file asks too; three wrong answers stop it.
  for (const wrong of ["1", "2", "3"]) {
    fireEvent.change(screen.getByLabelText("문서 암호"), { target: { value: wrong } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "암호로 열기" })); });
  }
  expect(convertToMarkdown.mock.calls.filter(([target]) => (target as { artifactId?: string }).artifactId === "pw2")).toHaveLength(4);
  expect(screen.getByText(/암호가 3번 맞지 않아/)).toBeTruthy();
  // The .xls (not a listed document) by its path; the PDF never sent.
  expect(convertToMarkdown).toHaveBeenCalledWith({ workId: "w", path: "/w/표.xls" }, { preset: "default", pages: "", images: true });
  expect(convertToMarkdown.mock.calls.some(([target]) => (target as { artifactId?: string }).artifactId === "pdf")).toBe(false);
  // The report: tables, pictures, warnings with their pages; nothing opened by itself.
  const report = screen.getByRole("list", { name: "변환 결과" });
  expect(report.textContent).toContain("표 1개, 그림 2개, 확인할 점 1가지");
  expect(report.textContent).toContain("3쪽: 삽입된 개체(OLE)는 가져오지 않았습니다.");
  expect(onOpen).not.toHaveBeenCalled();
  expect(JSON.stringify(convertToMarkdown.mock.calls)).not.toContain("localStorage");
});

it("내보내기: HWPX by default with HanMark's templates; a cover date only for the dated 공문서; the report line and 열기", async () => {
  const exportHangul = vi.fn(async () => ({ artifact: doc("주간 보고.hwpx", "hwpx", "x1"), warnings: ["그림 「밖」을(를) 넣지 못했습니다: 프로젝트 폴더 밖의 그림은 넣지 않습니다."], template: "한국언론학회" }));
  const api = { hangulChoices: async () => CHOICES, exportHangul } as unknown as Api;
  const onOpen = vi.fn();
  render(<HangulExportDialog api={api} artifact={doc("주간 보고.md", "markdown")} onOpen={onOpen} onClose={vi.fn()} />);
  await flush();
  expect(screen.getByRole("dialog", { name: "한글 문서로 내보내기" })).toBeTruthy();
  expect(screen.queryByText("HWPX를 양식으로 등록…")).toBeNull(); // the native chooser is the desktop app's
  expect(screen.queryByLabelText("표지 날짜")).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "내보내기" })); });
  expect(exportHangul).toHaveBeenCalledWith("a1", { format: "hwpx", template: "builtin:kordoc-default" });
  expect(screen.getByRole("status").textContent).toContain("한국언론학회 서식으로 만들었습니다. 확인할 점 1가지가 있습니다.");
  fireEvent.click(screen.getByRole("button", { name: "열기" }));
  expect(onOpen).toHaveBeenCalledWith("x1");
  expect(todayDot(new Date(2026, 10, 18))).toBe("2026. 11. 18.");
});

it("the 문서 section takes files dropped from the computer, not the app's own row drags", () => {
  const onFiles = vi.fn();
  render(<InsideSection id="docs" label="문서" count={0} folded={false} here={false} lead={null} onFold={vi.fn()} addLabel="새 문서" onAdd={vi.fn()} empty="없음" tools={<button type="button">문서 불러오기…</button>} onFiles={onFiles} />);
  expect(screen.getByRole("button", { name: "문서 불러오기…" })).toBeTruthy();
  const section = screen.getByRole("region", { name: "문서 0" });
  const file = new File(["x"], "받은.hwpx");
  fireEvent.dragOver(section, { dataTransfer: { types: ["Files"], files: [file] } });
  expect(section.className).toContain("hconv-drop");
  fireEvent.drop(section, { dataTransfer: { types: ["Files"], files: [file] } });
  expect(onFiles).toHaveBeenCalledWith([file]);
  fireEvent.drop(section, { dataTransfer: { types: ["application/x-workbench-row"], files: [] } });
  expect(onFiles).toHaveBeenCalledTimes(1);
});

// Word → Hangul (IeumOffice's docx2hwp, the gateway's office-convert.ts): the same dialog with a Word document.
const LEDGER = { title: "한글 문서로 내보내기", message: "한글 문서에서는 일부 내용이 바뀌거나 빠집니다.", sections: [{ heading: "바뀌는 것", items: ["하이퍼링크(글로만 남음)"] }, { heading: "빠지는 것", items: ["메모 (2)"] }] };

it("Word → Hangul: no 서식 to choose; the ledger BEFORE anything is written, 저장 writes, 열기 opens", async () => {
  const prepareWordHangul = vi.fn(async () => ({ ticket: "t1", format: "hwpx" as const, name: "통신문.hwpx", losses: 2, ledger: LEDGER }));
  const commitWordHangul = vi.fn(async () => ({ artifact: doc("통신문.hwpx", "hwpx", "h9") }));
  const api = { prepareWordHangul, commitWordHangul } as unknown as Api;
  const onOpen = vi.fn(), onDone = vi.fn();
  render(<HangulExportDialog api={api} artifact={doc("통신문.docx", "docx", "w1")} onOpen={onOpen} onDone={onDone} onClose={vi.fn()} />);
  expect(screen.queryByText("서식")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "새 문서 이름" }), { target: { value: "통신문" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "내보내기" })); });
  expect(prepareWordHangul).toHaveBeenCalledWith("w1", { format: "hwpx", name: "통신문" }, undefined);
  expect(commitWordHangul).not.toHaveBeenCalled();
  expect(screen.getByText("한글 문서에서는 일부 내용이 바뀌거나 빠집니다.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "바뀌는 것" })).toBeTruthy();
  expect(screen.getByText("메모 (2)")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "저장" })); });
  expect(commitWordHangul).toHaveBeenCalledWith("w1", "t1");
  expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: "h9" }));
  fireEvent.click(screen.getByRole("button", { name: "열기" }));
  expect(onOpen).toHaveBeenCalledWith("h9");
});

it("Word → Hangul: 취소 at the ledger writes nothing; nothing lost writes at once; the editor's own document and password go along", async () => {
  const prepareWordHangul = vi.fn(async () => ({ ticket: "t2", format: "hwp" as const, name: "a.hwp", losses: 0, ledger: { ...LEDGER, sections: [] } }));
  const commitWordHangul = vi.fn(async () => ({ artifact: doc("a.hwp", "hwp", "h2") }));
  const api = { prepareWordHangul, commitWordHangul } as unknown as Api;
  const bytes = new ArrayBuffer(4);
  render(<HangulExportDialog api={api} artifact={doc("a.docx", "docx", "w2")} editor={{ bytes, passwordSet: true }} onOpen={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText("편집기에 열린 내용(저장하지 않은 편집 포함)으로 만듭니다.")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "내보내기" })); });
  expect(prepareWordHangul).toHaveBeenCalledWith("w2", { format: "hwpx", passwordSet: true }, bytes);
  expect(commitWordHangul).toHaveBeenCalledWith("w2", "t2");
  cleanup();
  const lossy = vi.fn(async () => ({ ticket: "t3", format: "hwpx" as const, name: "b.hwpx", losses: 1, ledger: LEDGER }));
  const commit = vi.fn();
  const onClose = vi.fn();
  render(<HangulExportDialog api={{ prepareWordHangul: lossy, commitWordHangul: commit } as unknown as Api} artifact={doc("b.docx", "docx", "w3")} onOpen={vi.fn()} onClose={onClose} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "내보내기" })); });
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(commit).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it("변환해서 열기: an old .ppt opens as a key, not an editor; the copy opens and its one line is said", async () => {
  const { LegacyConvert } = await import("./LegacyConvert.tsx");
  const openConverted = vi.fn(async () => ({ artifact: doc("강의.pptx", "pptx", "p2"), line: "PPTX 사본으로 열었습니다. 슬라이드 노트·애니메이션은 옮기지 않았습니다. 원본 「강의.ppt」은 그대로 둡니다." }));
  const onOpen = vi.fn(), notify = vi.fn();
  render(<LegacyConvert api={{ openConverted } as unknown as Api} artifact={doc("강의.ppt", "ppt", "p1") as Artifact & { format: "ppt" }} onOpen={onOpen} notify={notify} />);
  expect(screen.getByText("PPT 97-2003(PPT) 파일은 바로 편집하지 않습니다.")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "변환해서 열기" })); });
  expect(openConverted).toHaveBeenCalledWith("p1");
  expect(onOpen).toHaveBeenCalledWith("p2");
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("슬라이드 노트·애니메이션은 옮기지 않았습니다."));
});
