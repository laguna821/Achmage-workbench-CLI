export type SvgPage = { svg: string; width: number; height: number };
export type SvgJob = { pages: SvgPage[]; images: string[] };
export type OfficeOutputPlan = { id: string; path: string; format: "hwp" | "hwpx" | "pdf"; replace: boolean };
export type OfficeOutputRequest =
  | { type: "office:output"; requestId: string; action: "prepare"; revision: number; format: "hwp" | "hwpx" }
  | { type: "office:output"; requestId: string; action: "commit"; planId: string; bytes: ArrayBuffer }
  | { type: "office:output"; requestId: string; action: "pdf" | "print"; revision: number; job: SvgJob };
export type OfficeOutputResult = { type: "office:output-result"; requestId: string; value?: OfficeOutputPlan | { path?: string; artifactId?: string } | null; error?: string };
