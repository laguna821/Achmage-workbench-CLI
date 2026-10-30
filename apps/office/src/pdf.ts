import { mountOfficeAi, officeAiTransport } from "./office-ai.ts";
import { Gateway, GatewayError, handshake, listen, post } from "./bridge.ts";
import { recovery } from "./recovery.ts";
import { dispatch, useTransport } from "./platform/electron-renderer.ts";
import type { PdfRequest } from "../../../packages/contracts/src/pdf.ts";

const init = await handshake(), gateway = new Gateway(init.token);
const ai = mountOfficeAi(init, gateway);
const id = init.artifact.id, path = init.artifact.path;
let revision = init.artifact.revision, contentRevision = revision, theme = init.theme;
let source = await gateway.raw(id, revision), restored = false, dirty = false, epoch = 0, opened = false;
if (init.recover && !init.readOnly) {
  const kept = await recovery.get(id);
  if (kept && kept.baseRevision <= revision) { source = kept.bytes; revision = contentRevision = kept.baseRevision; restored = true; }
} else if (!init.readOnly) await recovery.drop(id);
const workingSource = () => restored || revision !== contentRevision ? source : undefined;
const currentBytes = async () => { if (!source.byteLength) source = await gateway.raw(id, contentRevision); return source; };
const report = (error: unknown) => post({ type: "office:error", message: error instanceof Error ? error.message : String(error) });
let recoveryQueue = Promise.resolve();
const queueRecovery = (task: () => Promise<void>) => recoveryQueue = recoveryQueue.catch(() => {}).then(task);
let closeAnswer: ((ok: boolean) => void) | null = null, recoveryAnswer: (() => void) | null = null;
let recoveryFailure = false;
const checkPath = (value: unknown) => { if (value !== path) throw new Error("열린 PDF만 처리할 수 있습니다."); };
const requestOf = (value: unknown) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PDF 요청이 올바르지 않습니다."); const request = value as PdfRequest; checkPath(request.path); return request; };
async function keepRequest(request: PdfRequest) {
  if (init.readOnly) return "skipped";
  const before = epoch, baseRevision = revision;
  try {
    const bytes = await gateway.pdf<ArrayBuffer>(id, baseRevision, "recover", request, workingSource());
    if (epoch !== before) return "superseded";
    await queueRecovery(async () => { if (epoch === before) await recovery.put(id, { bytes, baseRevision, at: Date.now() }); });
    recoveryFailure = false; return epoch === before ? "written" : "superseded";
  } catch (error) { recoveryFailure = true; report(error); return "failed"; }
}
async function keep() {
  recoveryFailure = false;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { recoveryAnswer = null; reject(new Error("PDF 복구본을 받지 못했습니다. 편집 탭을 열어 두세요.")); }, 10000);
    recoveryAnswer = () => { clearTimeout(timer); recoveryAnswer = null; resolve(); };
    dispatch("pdf:recovery-flush-request", []);
  });
  await recoveryQueue;
  if (recoveryFailure) throw new Error("PDF 복구본을 만들지 못했습니다. 편집 탭을 열어 두세요.");
}
let flushing: Promise<void> | null = null;
async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      // AI tools update React state before the next close-save subscription is
      // installed. Capture that committed state, not the previous render's empty
      // snapshot. A hidden window still makes progress via the bounded timer.
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 100);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
      });
      const ok = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => { closeAnswer = null; resolve(false); }, 12000);
        closeAnswer = (value) => { clearTimeout(timer); closeAnswer = null; resolve(value); };
        dispatch("pdf:close-save-request", [{ flushAll: true }]);
      });
      // The original renderer subtracts only the saved snapshot. Let its post-save dirty
      // effect land before acknowledging, so typing during a save cannot be lost on close.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!ok || dirty) { await keep(); post({ type: "office:flushed", revision: null }); }
      else post({ type: "office:flushed", revision });
    } catch (error) { report(error); post({ type: "office:flushed", revision: null }); }
  })().finally(() => { flushing = null; });
  return flushing;
}
listen((message) => {
  if (message.type === "office:theme") { theme = message.theme; dispatch("app:theme-changed", [theme]); }
  if (message.type === "office:flush") void flush();
  if (message.type === "office:rebase") void currentBytes().then(() => { revision = message.revision; return flush(); }).catch((error) => { report(error); post({ type: "office:flushed", revision: null }); });
  if (message.type === "office:keep") void keep().catch(report).finally(() => post({ type: "office:flushed", revision: null }));
});

const queries: Record<string, string> = {
  "pdf:validate-text-edits": "validate-text", "pdf:page-image-png": "image-png", "pdf:page-preview-png": "preview-png",
};
const pathQueries: Record<string, string> = {
  "pdf:list-page-images": "images", "pdf:list-static-form-fills": "static-fills", "pdf:annot-subjects": "subjects", "pdf:list-digital-signatures": "signatures",
};
const transforms: Record<string, string> = { "pdf:insert-blank-page": "blank-page", "pdf:set-page-size": "page-size", "pdf:crop-pages": "crop" };
let prefs: Record<string, unknown> = {};
try { prefs = JSON.parse(localStorage.getItem("workbench.office.pdf.prefs") ?? "{}"); } catch { /* A damaged UI preference is not document data. */ }
const fail = (channel: string) => { throw new Error(`PDF의 이 서비스를 아직 연결하지 못했습니다: ${channel}`); };
const persistResult = async (next: number) => {
  revision = contentRevision = next; restored = false; epoch++;
  source = new ArrayBuffer(0);
  post({ type: "office:saved", revision });
  // The original file is saved already. A recovery-store failure must not replay those
  // operations onto the newly written PDF or misreport a successful file write as failed.
  await queueRecovery(() => recovery.drop(id)).catch(report);
};
useTransport({
  invoke: officeAiTransport(ai, dispatch, async (channel, args) => {
    if (queries[channel]) return gateway.pdf(id, revision, queries[channel], requestOf(args[0]), workingSource());
    if (pathQueries[channel]) { checkPath(args[0]); return gateway.pdf(id, revision, pathQueries[channel], { path }, workingSource()); }
    if (transforms[channel]) {
      if (init.readOnly) return { ok: false, error: "이 판은 읽기 전용입니다." };
      try {
        const result = await gateway.pdf<{ revision: number }>(id, revision, transforms[channel], requestOf(args[0]), workingSource());
        await persistResult(result.revision); return { ok: true };
      } catch (error) { report(error); return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    switch (channel) {
      case "pdf:consume-pending": return path;
      case "pdf:read-file": {
        checkPath(args[0]);
        if (!opened) { opened = true; post({ type: "office:opened", revision, recovered: restored }); }
        return (await currentBytes()).slice(0);
      }
      case "pdf:recovery-state": checkPath(args[0]); return { unsaved: restored };
      case "pdf:recovery-write-copy": return keepRequest(requestOf(args[0]));
      case "pdf:recovery-unprotectable": return args[0] ? "암호화된 PDF는 복구본을 보관하지 않습니다." : null;
      case "pdf:recovery-resume": return;
      case "pdf:template-bytes": return new Uint8Array(await gateway.pdf<ArrayBuffer>(id, revision, "recover", requestOf(args[0]), workingSource()));
      case "pdf:save": {
        if (init.readOnly) return { ok: false, error: "이 판은 읽기 전용입니다." };
        const request = requestOf(args[0]);
        try {
          const result = await gateway.savePdf(id, revision, request, workingSource());
          await persistResult(result.revision);
          return { ok: true, ...result };
        } catch (error) {
          await keepRequest(request);
          if (error instanceof GatewayError && error.status === 409) { post({ type: "office:conflict", code: error.code, message: error.message }); return { ok: false, error: "external-modified" }; }
          report(error); return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "pdf:list-edit-fonts": return gateway.pdf(id, revision, "fonts", {});
      case "pdf:can-draw-text": return gateway.pdf(id, revision, "can-draw", { text: args[0], font: args[1], bold: args[2], italic: args[3] });
      case "pdf:ocr-page": return null; // Original Linux contract: no system OCR engine.
      case "pdf:get-username": return ""; // Original /T default stays GenOffice until account preferences are connected.
      case "pdf:auto-rename": checkPath(args[0]); return { renamed: false };
      case "pdf:is-untitled": case "pdf:is-untitled-copy": checkPath(args[0]); return false;
      case "pdf:note-unsaved": return false;
      case "app:get-language": return "ko";
      case "app:get-theme": return theme;
      case "app:get-auto-save-default": return { on: false, updatedAt: 0 };
      case "app:get-ai-panel-prefs": return prefs;
      case "app:set-ai-panel-prefs": {
        if (args[0] && typeof args[0] === "object") prefs = { ...prefs, ...args[0] };
        localStorage.setItem("workbench.office.pdf.prefs", JSON.stringify(prefs)); dispatch("app:ai-panel-prefs-changed", [prefs]); return prefs;
      }
      // Keep missing services visible through the original preload's structured failure
      // contracts. No generic null/empty-success proxy, and no implicit model invocation.
      default: return fail(channel);
    }
  }),
  send(channel, args) {
    if (channel === "pdf:dirty-changed") { dirty = args[0] === true; post({ type: "office:dirty", dirty }); }
    else if (channel === "pdf:close-save-result") closeAnswer?.(args[0] === true);
    else if (channel === "pdf:recovery-flush-done") recoveryAnswer?.();
  },
});
await import("@ieum/apps/pdf/src/preload/index.ts");
await import("@ieum/apps/pdf/src/renderer/main.tsx");
