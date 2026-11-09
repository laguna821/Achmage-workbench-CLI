import type { OfficeUiAdapter } from "../ui-adapters.ts";

/** Original 스프레드시트 menu IDs plus the live renderer's existing ribbon controls. */
export const sheetsAdapter: OfficeUiAdapter = {
  label: "스프레드시트",
  roots: ".ribbon, .toolbar, [role=toolbar], [role=menubar], [role=tablist], .univer-toolbar, .univer-menu",
  commands: [
    ["save", "저장", "파일", "Ctrl+S"],
    ["save-as", "다른 이름으로 저장", "파일", "Ctrl+Shift+S"],
    ["undo", "실행 취소", "편집", "Ctrl+Z"],
    ["redo", "다시 실행", "편집", "Ctrl+Shift+Z"],
    ["print", "인쇄", "파일", "Ctrl+P"],
    ["export-pdf", "PDF로 내보내기", "파일"],
    ["export-csv", "CSV로 내보내기", "파일"],
  ],
};
