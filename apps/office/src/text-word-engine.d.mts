export type OdtReport = { kind: "converted" | "dropped"; feature: string; count: number }[];
export type ExportResult = { ok: true; path: string } | { ok: true; canceled: true } | { ok: false; error: string };
export type ReportDialog = { title?: string; message: string; detail?: string; buttons?: string[]; cancelId?: number; defaultId?: number };
export function exportOdt(steps: {
  pickPath(): Promise<string | null>;
  docx(): Promise<Uint8Array>;
  confirm(report: OdtReport): Promise<boolean>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}): Promise<ExportResult>;
export function confirmOdtReport(report: OdtReport, show: (options: ReportDialog) => Promise<{ response: number }>, lang: "ko"): Promise<boolean>;
