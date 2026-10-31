export type SvgPage = { svg: string; width: number; height: number };
export type SvgJob = { pages: SvgPage[]; images: string[] };
/** Original renderer print markup, with embedded images/styles/fonts. Sizes are inches. */
export type HtmlJob = { html: string; assets?: { mime: string; base64: string }[]; widthIn: number; heightIn: number; margins: { top: number; right: number; bottom: number; left: number }; scale: number };
/** File extensions, including the original spelling for Markdown/HTML and macro workbooks. */
export type OfficeOutputFormat = "hwp" | "hwpx" | "pdf" | "docx" | "pptx" | "xlsx" | "xlsm" | "md" | "markdown" | "html" | "htm" | "xmind" | "epub";
export type OfficeOutputPlan = { id: string; path: string; format: OfficeOutputFormat; replace: boolean };
export type OfficeOutputRequest =
  | { type: "office:output"; requestId: string; action: "cancel"; planId?: string; preparationId?: string }
  | { type: "office:output"; requestId: string; action: "prepare"; revision: number; format: OfficeOutputFormat }
  | { type: "office:output"; requestId: string; action: "commit"; planId: string; bytes: ArrayBuffer }
  | { type: "office:output"; requestId: string; action: "pdf" | "print"; revision: number; job: SvgJob }
  | { type: "office:output"; requestId: string; action: "html-pdf" | "html-print" | "html-render"; revision: number; job: HtmlJob };
export type OfficeOutputResult = { type: "office:output-result"; requestId: string; value?: OfficeOutputPlan | { path?: string; artifactId?: string } | ArrayBuffer | null; error?: string };
