import type { OfficeUiAdapter } from "../ui-adapters.ts";

/** Original HTML menu IDs plus the live renderer's existing ribbon controls. */
export const htmlAdapter: OfficeUiAdapter = {
  label: "HTML",
  roots: ".ribbon, .toolbar, [role=toolbar], [role=menubar], [role=tablist]",
  commands: [
    ["save", "저장", "파일", "Ctrl+S"],
    ["save-as", "다른 이름으로 저장", "파일", "Ctrl+Shift+S"],
    ["print", "인쇄", "파일", "Ctrl+P"],
    ["export-pdf", "PDF로 내보내기", "파일"],
    ["export-docx", "Word로 내보내기", "파일"],
    ["export-odt", "ODT로 내보내기", "파일"],
    ["export-html", "단일 HTML 파일로 내보내기", "파일"],
  ],
};
