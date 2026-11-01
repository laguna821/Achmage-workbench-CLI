import type { OfficeAiBridge } from "./office-ai.ts";
import type { Gateway, Init } from "./bridge.ts";
import type { OfficeOutputPlan } from "../../../packages/contracts/src/office-output.ts";
import { cancelOutput, commitGeneratedOutput, openExport, prepareOutput, revealExport } from "./output.ts";
import { dispatch } from "./platform/electron-renderer.ts";

type Outcome = { ok?: boolean; error?: string; message?: string; generatedId?: string; [key: string]: unknown };
type JobView = { kind: string; state: string; done: number; total: number; error?: string };
/** Original PDF engine/store calls and their independent model runs. */
export function pdfJobs(init: Init, gateway: Gateway, ai: OfficeAiBridge, revision: () => number) {
  const instance = crypto.randomUUID(), plans = new Map<string, OfficeOutputPlan>();
  const shortCalls = new Map<string, { job: ReturnType<OfficeAiBridge["createReadingJob"]>; cancel: boolean }>();
  const direct = {
    onAiStream: ai.desktop.onAiStream,
    async aiStream(request: { requestId: string } & Record<string, unknown>) {
      const job = ai.createReadingJob(), current = { job, cancel: false };
      if (shortCalls.has(request.requestId)) { job.dispose(); throw new Error("이미 진행 중인 읽기 요청입니다."); }
      shortCalls.set(request.requestId, current);
      let text = "", unsubscribe = () => {};
      const finish = async (status: "completed" | "failed" | "interrupted", message: string) => {
        unsubscribe(); shortCalls.delete(request.requestId);
        try { await job.finish(status, message); } finally { job.dispose(); }
      };
      try {
        await job.start("PDF 읽기 도우미 요청");
        if (current.cancel) { await finish("interrupted", "읽기 요청을 중단했습니다."); throw new DOMException("읽기 요청 중단", "AbortError"); }
        unsubscribe = job.onAiStream(value => {
          const chunk = value as { requestId: string; type: string; text?: string; error?: string };
          if (chunk.requestId !== request.requestId) return;
          if (chunk.type === "delta") text += chunk.text ?? "";
          if (chunk.type === "done" || chunk.type === "error") void finish(current.cancel ? "interrupted" : chunk.type === "error" ? "failed" : "completed", chunk.error ?? (text || "PDF 읽기 도우미 응답을 받았습니다.")).catch(report);
        });
        await job.aiStream(request);
      } catch (error) { if (shortCalls.has(request.requestId)) await finish("failed", error instanceof Error ? error.message : String(error)); throw error; }
    },
    async aiStreamCancel(requestId: string) { const current = shortCalls.get(requestId); if (current) { current.cancel = true; await current.job.aiStreamCancel(requestId); } },
  };
  function report(error: unknown) { console.error("PDF 작업 기록:", error instanceof Error ? error.message : String(error)); }
  const finish = async (view: JobView) => {
    const status = view.state === "complete" ? "completed" : view.state === "stopped" ? "interrupted" : "failed";
    await ai.job.finish(status, `PDF ${view.kind}: ${view.done}/${view.total}${view.error ? ` · ${view.error}` : ""}`).catch(report);
  };
  Object.assign(window, { workbenchPdfJobs: { model: (longJob: boolean) => longJob ? ai.job : direct, finish } });
  const call = (operation: string, args: unknown[]) => gateway.pdfStructure<Outcome>(init.artifact.id, revision(), instance, operation, args, value => dispatch("pdf:structure-progress", [value]));
  window.addEventListener("pagehide", () => {
    for (const current of shortCalls.values()) current.job.dispose();
    void gateway.closePdfStructure(init.artifact.id, instance);
  });
  return async (channel: string, args: unknown[]): Promise<{ handled: boolean; value?: unknown }> => {
    if (channel === "pdf:structure-pick-target") {
      const request = args[0] as { path: string; kind: string; defaultName?: string };
      if (request.path !== init.artifact.path || !["md", "epub", "pdf"].includes(request.kind)) throw new Error("이 PDF의 문서 출력 형식을 선택해 주세요.");
      const format = request.kind as "md" | "epub" | "pdf";
      const stem = request.defaultName || init.artifact.name.replace(/\.pdf$/i, "");
      const defaultName = stem.toLowerCase().endsWith(`.${format}`) ? stem : `${stem}.${format}`;
      const plan = await prepareOutput(revision(), format, crypto.randomUUID(), { defaultName, longJob: true });
      if (plan) { const prior = plans.get(plan.path); if (prior) await cancelOutput(prior.id); plans.set(plan.path, plan); }
      return { handled: true, value: plan?.path ?? null };
    }
    if (channel === "pdf:convert-release-target") {
      const request = args[0] as { source: string; path: string };
      // The parent ticket already excludes every path currently open in an editor.
      return { handled: true, value: request.source === init.artifact.path && plans.has(request.path) };
    }
    if (channel === "pdf:convert-reveal-result") { await revealExport(String((args[0] as { path: string }).path)); return { handled: true, value: true }; }
    if (channel === "home:open-path" || channel === "pdf:convert-open-result") { await openExport(String((args[0] as { path?: string })?.path ?? args[0])); return { handled: true, value: true }; }
    if (!/^pdf:(?:structure|store)-/.test(channel)) return { handled: false };
    const operation = channel.replace(/^pdf:/, "").replace(/^structure-/, "");
    const request = args[0] as Record<string, unknown> | undefined;
    const job = operation === "store-write" && request?.kind === "job" ? request.job as { kind: string; state: string; lang?: string } : null;
    if (job?.state === "running") await ai.job.start(`PDF ${job.kind}${job.lang ? ` → ${job.lang}` : ""}`);
    const plan = operation === "convert" || operation === "write-back" ? plans.get(String(request?.outPath)) : null;
    if ((operation === "convert" || operation === "write-back") && !plan) throw new Error("결과 저장 위치를 먼저 선택해 주세요.");
    const result = await call(operation, args);
    if (job && !result.ok) await finish({ kind: job.kind, state: "failed", done: 0, total: 0, error: result.message ?? result.error });
    if (plan && result.ok && result.generatedId) {
      const saved = await commitGeneratedOutput(plan.id, result.generatedId, revision());
      plans.delete(plan.path); delete result.generatedId; result.outPath = saved.path;
    }
    return { handled: true, value: result };
  };
}
