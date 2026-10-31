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
export const prepareOutput = (revision: number, format: OfficeOutputFormat, requestId = crypto.randomUUID()) => request<OfficeOutputPlan | null>({ type: "office:output", requestId, action: "prepare", revision, format });
export const commitOutput = (planId: string, bytes: ArrayBuffer) => request<{ path: string; artifactId: string }>({ type: "office:output", requestId: crypto.randomUUID(), action: "commit", planId, bytes });
export const cancelOutput = (planId?: string, preparationId?: string) => request<null>({ type: "office:output", requestId: crypto.randomUUID(), action: "cancel", ...(planId ? { planId } : {}), ...(preparationId ? { preparationId } : {}) });
export const printOutput = (revision: number, job: SvgJob, action: "pdf" | "print") => request<{ path?: string } | null>({ type: "office:output", requestId: crypto.randomUUID(), action, revision, job });
export const htmlOutput = (revision: number, job: HtmlJob, action: "html-pdf" | "html-print") => request<{ path?: string } | null>({ type: "office:output", requestId: crypto.randomUUID(), action, revision, job });
export const renderHtmlPdf = (revision: number, job: HtmlJob) => request<ArrayBuffer>({ type: "office:output", requestId: crypto.randomUUID(), action: "html-render", revision, job });
export const browserOperation = <T extends BrowserResult | null>(revision: number, command: BrowserCommand) => request<T>({ type: "office:output", requestId: crypto.randomUUID(), action: "browser", revision, command });
