import type { OfficeUiAdapter } from "../ui-adapters.ts";

/** Original EPUB menu IDs plus the live renderer's existing ribbon controls. */
export const epubAdapter: OfficeUiAdapter = {
  label: "EPUB",
  roots: ".ribbon, .toolbar, [role=toolbar], [role=menubar], [role=tablist]",
  commands: [
    ["save", "저장", "파일", "Ctrl+S"],
    ["save-as", "다른 이름으로 저장", "파일", "Ctrl+Shift+S"],
    ["undo", "실행 취소", "편집", "Ctrl+Z"],
    ["redo", "다시 실행", "편집", "Ctrl+Shift+Z"],
    ["find", "찾기", "편집", "Ctrl+F"],
    ["replace", "바꾸기", "편집", "Ctrl+H"],
    ["zoom-in", "확대", "보기"],
    ["zoom-out", "축소", "보기"],
    ["zoom-reset", "기본 배율", "보기"],
    ["translate-book", "책 번역", "도구"],
  ],
};
