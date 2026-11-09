import type { OfficeUiAdapter } from "../ui-adapters.ts";

/** Original 슬라이드 menu IDs plus the live renderer's existing ribbon controls. */
export const slidesAdapter: OfficeUiAdapter = {
  label: "슬라이드",
  roots: ".ribbon, .toolbar, [role=toolbar], [role=menubar], [role=tablist]",
  commands: [
    ["save", "저장", "파일", "Ctrl+S"],
    ["save-as", "다른 이름으로 저장", "파일", "Ctrl+Shift+S"],
    ["undo", "실행 취소", "편집", "Ctrl+Z"],
    ["redo", "다시 실행", "편집", "Ctrl+Shift+Z"],
    ["cut", "잘라내기", "편집"],
    ["copy", "복사", "편집"],
    ["paste", "붙여넣기", "편집"],
    ["zoom-in", "확대", "보기"],
    ["zoom-out", "축소", "보기"],
    ["zoom-reset", "기본 배율", "보기"],
    ["print", "인쇄", "파일", "Ctrl+P"],
    ["export-pdf", "PDF로 내보내기", "파일"],
    ["export-images", "그림으로 내보내기", "파일"],
  ],
};
