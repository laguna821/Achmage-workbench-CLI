// What IeumOffice v0.13.0's Hangul renderer asks of window.hwpApi beyond 0.5.4's bridge (unit hwp13), where
// the answer is not the document's: the File menu's print route, 고급 인쇄, and the members behind what the
// Hangul AI is not offered. Every one answers in a plain Korean sentence; none throws.

type Emitter = { emit(name: string, ...args: unknown[]): void };

/**
 * The editor's File menu and the tab's commands, past Save: 인쇄 and Ctrl+P open the print preview (and print
 * from it when it is open), 인쇄 미리 보기 only opens it, PDF exports at once. 열기 and PDF 가져오기 are not in
 * Workbench's File menu (scripts/hwp-studio-090.mjs `workbench-file-menu`); anything else is ignored.
 */
export function hangulFileCommand(events: Emitter, command: string) {
  if (command === "print") events.emit("previewRequest", "print");
  else if (command === "preview") events.emit("previewRequest", "open");
  else if (command === "pdf") events.emit("printRequest", "pdf");
}

export const PRINT_LAYOUT_NOT_YET = "고급 인쇄(모아 찍기, 소책자, 라벨 등)는 아직 연결되지 않았습니다. 미리 보기의 인쇄와 PDF 저장은 그대로 쓸 수 있습니다.";

/** 고급 인쇄 (the shared print layout, upstream's Electron worker with PDFium): not connected, said in words. */
export const hangulPrintLayout = {
  preview: async () => ({ ok: false as const, error: PRINT_LAYOUT_NOT_YET }),
  print: async () => ({ ok: false as const, error: PRINT_LAYOUT_NOT_YET }),
  savePdf: async () => ({ ok: false as const, error: PRINT_LAYOUT_NOT_YET }),
  cancel: async () => {},
  onProgress: () => () => {},
  getLabelSpec: async () => null,
  setLabelSpec: async () => ({ ok: false as const, error: PRINT_LAYOUT_NOT_YET }),
};

export const ATTACHMENT_DOCUMENT_NOT_YET = "첨부한 한글 문서의 서식 읽기는 아직 연결되지 않았습니다. 이 문서의 서식은 그대로 읽을 수 있습니다.";
export const IMPORT_NOT_OFFERED = "첨부 파일을 새 한글 문서로 여는 기능은 제공하지 않습니다. 새 한글 문서는 '한글 문서 만들기'로 만드세요.";
export const WEB_SEARCH_NOT_OFFERED = "한글 문서 AI에는 웹 검색이 연결되지 않았습니다.";
export const PICTURE_NOT_OFFERED = "한글 문서 AI는 문서 속 그림을 볼 수 없습니다. 그림에 무엇이 있는지는 사용자에게 물어보세요.";

/**
 * The members behind what the Hangul AI is not offered (apps/office/hwp-offer-patch.ts): the tools are not in
 * the model's list, so these answer only a call that comes anyway, in the shape its caller reads.
 * `noteAiRunStop`: upstream keeps the stop (rule, fault counts, tool names: no document text) in a crash
 * record; here it goes to the page's console.
 */
export const HANGUL_NOT_OFFERED = {
  readAttachmentDocument: async (_path: string) => ({ ok: false as const, error: ATTACHMENT_DOCUMENT_NOT_YET }),
  importAttachmentAsDocument: async (_path: string, _request?: string) => ({ ok: false as const, error: IMPORT_NOT_OFFERED }),
  webSearch: async (_query: string, _maxResults?: number) => ({ results: [] as { title: string; url: string; snippet: string }[], method: "error", error: WEB_SEARCH_NOT_OFFERED }),
  analyzeMedia: async (_op: { mediaUrls: string[]; requirements: string }) => ({ error: PICTURE_NOT_OFFERED }),
  noteAiRunStop: (stop: unknown) => {
    const kind = stop && typeof stop === "object" && typeof (stop as { kind?: unknown }).kind === "string" ? (stop as { kind: string }).kind : "unknown";
    console.warn(`[hwp] the AI run was stopped by the editor's own rule (${kind})`);
  },
};
