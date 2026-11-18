import type { ConvertJob, ConvertReply } from "./office-convert.ts";
/** One conversion job, in this process (office-convert-work.mjs). */
export function runConvertJob(job: ConvertJob): Promise<ConvertReply>;
/** The xlsx engine's ConvertWorkbook on two files of one folder, through WASI. */
export function convertWorkbookWasm(wasm: string, folder: string, input: string, output: string): Promise<{ sheets: number; cells: number; formulasDropped: number }>;
