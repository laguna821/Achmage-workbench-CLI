import type { BrowserCommand, BrowserResult, HtmlJob, OfficeOutputFormat, OfficeOutputPlan, OfficeOutputRequest, SvgJob } from "../../../packages/contracts/src/office-output.ts";
import { listen, post } from "./bridge.ts";
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
listen((message) => {
  if (message.type !== "office:output-result") return;
  const waiter = pending.get(message.requestId); if (!waiter) return;
  pending.delete(message.requestId);
  if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.value ?? null);
});
function request<T>(message: OfficeOutputRequest): Promise<T> {
  return new Promise((resolve, reject) => { pending.set(message.requestId, { resolve: (value) => resolve(value as T), reject }); post(message); });
}
export const prepareOutput = (revision: number, format: OfficeOutputFormat, requestId = crypto.randomUUID(), options: { defaultName?: string; longJob?: boolean } = {}) => request<OfficeOutputPlan | null>({ type: "office:output", requestId, action: "prepare", revision, format, ...options });
export function commitOutput(planId: string, bytes: ArrayBuffer): Promise<{ path: string; artifactId: string }>;
export function commitOutput(planId: string, bytes: ArrayBuffer, intent: "export" | "open", sourceRevision?: number): Promise<{ path: string; artifactId: string | null }>;
export async function commitOutput(planId: string, bytes: ArrayBuffer, intent: "copy" | "export" | "open" = "copy", sourceRevision?: number) {
  const saved = await request<{ path: string; artifactId: string | null }>({ type: "office:output", requestId: crypto.randomUUID(), action: "commit", planId, bytes, intent, ...(sourceRevision === undefined ? {} : { sourceRevision }) });
  if (intent === "copy" && !saved.artifactId) throw new Error("내보낸 파일은 문서 목록에서 열 수 있는 형식이 아닙니다.");
  return saved;
}
export const cancelOutput = (planId?: string, preparationId?: string) => request<null>({ type: "office:output", requestId: crypto.randomUUID(), action: "cancel", ...(planId ? { planId } : {}), ...(preparationId ? { preparationId } : {}) });
export const openExport = (path: string) => request<null>({ type: "office:output", requestId: crypto.randomUUID(), action: "open-export", path });
export const printOutput = (revision: number, job: SvgJob, action: "pdf" | "print") => request<{ path?: string } | null>({ type: "office:output", requestId: crypto.randomUUID(), action, revision, job });
export const htmlOutput = (revision: number, job: HtmlJob, action: "html-pdf" | "html-print") => request<{ path?: string } | null>({ type: "office:output", requestId: crypto.randomUUID(), action, revision, job });
export const renderHtmlPdf = (revision: number, job: HtmlJob) => request<ArrayBuffer>({ type: "office:output", requestId: crypto.randomUUID(), action: "html-render", revision, job });
export const browserOperation = <T extends BrowserResult | null>(revision: number, command: BrowserCommand) => request<T>({ type: "office:output", requestId: crypto.randomUUID(), action: "browser", revision, command });

export const commitGeneratedOutput = (planId: string, generatedId: string, sourceRevision: number) => request<{ path: string; artifactId: string | null }>({ type: "office:output", requestId: crypto.randomUUID(), action: "commit", planId, generatedId, sourceRevision, bytes: new ArrayBuffer(0), intent: "export" });

export const revealExport = (path: string) => request<null>({ type: "office:output", requestId: crypto.randomUUID(), action: "reveal-export", path });
export const presentHtml = (title: string, url: string) => request<null>({ type: "office:output", requestId: crypto.randomUUID(), action: "present", title, url });
export const prepareImageOutput = (revision: number, name: string, job: HtmlJob) => request<{ id: string; pdfBase64: string } | null>({ type: "office:output", requestId: crypto.randomUUID(), action: "images-prepare", revision, name, job });
export const writeImageOutput = (id: string, page: number, base64: string) => request<{ ok: boolean }>({ type: "office:output", requestId: crypto.randomUUID(), action: "images-write", id, page, base64 });
export const finishImageOutput = (id: string, success: boolean) => request<{ ok: true; path?: string; canceled?: true }>({ type: "office:output", requestId: crypto.randomUUID(), action: "images-finish", id, success });
