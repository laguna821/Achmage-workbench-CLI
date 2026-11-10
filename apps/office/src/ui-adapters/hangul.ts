import type { OfficeUiAdapter } from "../ui-adapters.ts";

/** Original 한글 menu IDs plus the live renderer's existing ribbon controls. */
export const hangulAdapter: OfficeUiAdapter = {
  label: "한글",
  roots: ".hwp-topbar, .ribbon, .toolbar, .menubar, #toolbar, #ribbon, #menu-bar, #icon-toolbar, #style-bar, [role=toolbar], [role=menubar], [role=tablist]",
  frames: ".hwp-editor-host iframe",
  commands: [
    ["save", "저장", "파일", "Ctrl+S"],
    ["save-as", "다른 이름으로 저장", "파일", "Ctrl+Shift+S"],
    ["print", "인쇄", "파일", "Ctrl+P"],
    ["export-pdf", "PDF로 내보내기", "파일"],
  ],
};
