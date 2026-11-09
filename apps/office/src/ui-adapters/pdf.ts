import type { OfficeUiAdapter } from "../ui-adapters.ts";

/** Original PDF menu IDs plus the live renderer's existing ribbon controls. */
export const pdfAdapter: OfficeUiAdapter = {
  label: "PDF",
  roots: ".ribbon, .toolbar, [role=toolbar], [role=menubar], [role=tablist]",
  commands: [
    ["save-as", "사본으로 저장", "파일"],
    ["print", "인쇄", "파일", "Ctrl+P"],
  ],
};
