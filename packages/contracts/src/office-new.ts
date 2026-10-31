/** The original Ieum shell's blank document types (EPUB opens existing books). */
export const BLANK_OFFICE_DOCUMENTS = [
  { format: "docx", extension: "docx", label: "워드 문서", name: "새 워드" },
  { format: "pptx", extension: "pptx", label: "프레젠테이션", name: "새 프레젠테이션" },
  { format: "xlsx", extension: "xlsx", label: "스프레드시트", name: "새 스프레드시트" },
  { format: "hwpx", extension: "hwpx", label: "한글 문서", name: "새 한글" },
  { format: "pdf", extension: "pdf", label: "PDF 문서", name: "새 PDF" },
  { format: "markdown", extension: "md", label: "Markdown 문서", name: "새 Markdown" },
  { format: "html", extension: "html", label: "HTML 문서", name: "새 HTML" },
  { format: "xmind", extension: "xmind", label: "마인드맵", name: "새 마인드맵" },
] as const;

export type BlankOfficeFormat = typeof BLANK_OFFICE_DOCUMENTS[number]["format"];
export type NewOfficeDocument = { format: BlankOfficeFormat; name?: string; workspaceId?: string; sessionId?: string };
