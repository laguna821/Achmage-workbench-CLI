export type SvgPage = { svg: string; width: number; height: number };
export type SvgJob = { pages: SvgPage[]; images: string[] };
/** File extensions, including the original spelling for Markdown/HTML and macro workbooks. */
export type OfficeOutputFormat = "hwp" | "hwpx" | "pdf" | "docx" | "pptx" | "xlsx" | "xlsm" | "md" | "markdown" | "html" | "htm" | "xmind" | "epub";
export type OfficeOutputPlan = { id: string; path: string; format: OfficeOutputFormat; replace: boolean };
export type OfficeOutputRequest =
  | { type: "office:output"; requestId: string; action: "prepare"; revision: number; format: OfficeOutputFormat }
  | { type: "office:output"; requestId: string; action: "commit"; planId: string; bytes: ArrayBuffer }
  | { type: "office:output"; requestId: string; action: "pdf" | "print"; revision: number; job: SvgJob };
export type OfficeOutputResult = { type: "office:output-result"; requestId: string; value?: OfficeOutputPlan | { path?: string; artifactId?: string } | null; error?: string };
