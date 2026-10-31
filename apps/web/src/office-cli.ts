import { invoke } from "@tauri-apps/api/core";
import type { OfficeHostMessage, OfficePageMessage } from "@workbench/contracts";
import type { OfficeOutputPlan, OfficeOutputRequest, OfficeOutputResult } from "../../../packages/contracts/src/office-output.ts";
import { Api, readToken } from "./api.ts";

type ExportRequest = { input: string; outPath: string; cwd: string; format: "pdf" | "html" | "docx" };

/** Hidden parent for the original Office renderer. The native process fixes the
 * input/output paths and owns an isolated gateway and ephemeral browser profile. */
export async function runOfficeCli() {
  let finished = false;
  let outputError: string | undefined;
  let closeDocument: (() => Promise<void>) | undefined;
  const done = async (ok: boolean, error?: string) => {
    if (finished) return;
    finished = true;
    try { await closeDocument?.(); }
    catch (cause) { ok = false; error ??= cause instanceof Error ? cause.message : String(cause); }
    await invoke("office_cli_done", { ok, error: error ?? null });
  };
  try {
    const job = await invoke<ExportRequest>("office_cli_job");
    const token = readToken(); if (!token) throw new Error("내보내기 게이트웨이 인증이 없습니다.");
    const rootApi = new Api(token);
    const work = await rootApi.createWork("문서 내보내기", null, job.cwd);
    const input = await rootApi.officeCliInput();
    const artifact = await rootApi.openFile(work.id, input.path);
    const viewId = `view-${crypto.randomUUID()}`, windowId = `window-${crypto.randomUUID()}`;
    let heartbeat: number | undefined;
    let pending: Promise<unknown> = Promise.resolve();
    const register = () => pending = pending.then(() => finished ? undefined : rootApi.registerDocument(artifact.id, {
      viewId, windowId, claim: false, dirty: false, revision: artifact.revision, sessionId: null,
    }));
    closeDocument = async () => {
      window.clearInterval(heartbeat);
      await pending.catch(() => undefined);
      await rootApi.closeDocument(viewId, windowId);
    };
    await register();
    heartbeat = window.setInterval(() => void register().catch(error => void done(false, String(error))), 10_000);
    const api = rootApi.forDocument(() => ({ viewId, writeToken: null }));
    const grant = await api.editorGrant(artifact.id);
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;background:white";
    const plans = new Set<string>();
    const send = (message: OfficeHostMessage) => frame.contentWindow?.postMessage(message, grant.origin);
    const write = async (bytes: ArrayBuffer) => ({ path: await invoke<string>("office_cli_write", new Uint8Array(bytes)), artifactId: artifact.id });
    const output = async (message: OfficeOutputRequest): Promise<OfficeOutputResult["value"]> => {
      if (message.action === "cancel") { if (message.planId) plans.delete(message.planId); return null; }
      if (message.action === "html-render") return invoke<ArrayBuffer>("render_html_pdf", { job: message.job });
      if (message.action === "browser") return invoke("office_browser", { command: message.command });
      if (message.action === "prepare") {
        if (message.format !== job.format) throw new Error("CLI에서 요청한 내보내기 형식과 다릅니다.");
        const id = crypto.randomUUID(); plans.add(id);
        return { id, path: job.outPath, format: job.format, replace: true } satisfies OfficeOutputPlan;
      }
      if (message.action === "commit") {
        if (!plans.delete(message.planId) || !(message.bytes instanceof ArrayBuffer)) throw new Error("내보내기 저장 요청이 올바르지 않습니다.");
        return write(message.bytes);
      }
      if (message.action === "html-pdf" || message.action === "pdf") {
        if (job.format !== "pdf") throw new Error("PDF 내보내기 요청이 아닙니다.");
        return write(await invoke<ArrayBuffer>(message.action === "html-pdf" ? "render_html_pdf" : "render_svg_pdf", { job: message.job }));
      }
      throw new Error("CLI 내보내기에서는 인쇄 대화상자를 열 수 없습니다.");
    };
    window.addEventListener("message", (event: MessageEvent<OfficePageMessage>) => {
      if (event.source !== frame.contentWindow || event.origin !== grant.origin || finished) return;
      const message = event.data;
      if (message?.type === "office:ready") {
        send({ type: "office:init", token: grant.token, sessionId: null,
          artifact: { id: artifact.id, name: artifact.name, path: artifact.path, revision: artifact.revision, sha256: artifact.sha256 },
          readOnly: true, theme: "light", recover: false, headlessExport: { outPath: job.outPath, format: job.format } });
      } else if (message?.type === "office:output") {
        void output(message).then(value => send({ type: "office:output-result", requestId: message.requestId, value }),
          error => { outputError = String(error); send({ type: "office:output-result", requestId: message.requestId, error: outputError }); });
      } else if (message?.type === "office:headless-result") {
        void done(message.ok, message.ok ? undefined : outputError ?? message.error);
      } else if (message?.type === "office:error") {
        void done(false, message.message);
      }
    });
    document.body.append(frame);
    frame.src = grant.url;
  } catch (error) { await done(false, error instanceof Error ? error.message : String(error)); }
}
