import type { OfficeUiAdapter } from "../ui-adapters.ts";

/** Original Markdown menu IDs plus the live renderer's existing ribbon controls. */
export const markdownAdapter: OfficeUiAdapter = {
  label: "Markdown",
  roots: ".ribbon, .toolbar, [role=toolbar], [role=menubar], [role=tablist]",
  commands: [
    ["save", "저장", "파일", "Ctrl+S"],
    ["save-as", "다른 이름으로 저장", "파일", "Ctrl+Shift+S"],
    ["print", "인쇄", "파일", "Ctrl+P"],
    ["export-pdf", "PDF로 내보내기", "파일"],
    ["export-docx", "Word로 내보내기", "파일"],
    ["export-odt", "ODT로 내보내기", "파일"],
    ["export-images", "PNG로 내보내기", "파일"],
    ["open-docx", "Word로 변환해 열기", "파일"],
  ],
};
