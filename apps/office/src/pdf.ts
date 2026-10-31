import { mountOfficeAi, officeAiTransport } from "./office-ai.ts";
import { Gateway, GatewayError, handshake, listen, post } from "./bridge.ts";
import { recovery } from "./recovery.ts";
import { dispatch, useTransport } from "./platform/electron-renderer.ts";
import type { PdfRequest } from "../../../packages/contracts/src/pdf.ts";
import { bindPdfHistory, pdfHistory, type PdfHistoryBase } from "./pdf-history.ts";
import { beginOfficeCopy, officeCopyBusy, type OfficeCopy } from "./copy.ts";

const init = await handshake(), gateway = new Gateway(init.token);
const ai = mountOfficeAi(init, gateway);
const id = init.artifact.id, path = init.artifact.path;
let revision = init.artifact.revision, contentRevision = revision, theme = init.theme;
let source = await gateway.raw(id, revision), restored = false, dirty = false, epoch = 0, opened = false;
let writing = 0, copyOpening = false;
let copyState: { turn: OfficeCopy; redaction: boolean; finish(ok: boolean): void } | null = null;
const copying = () => copyOpening || copyState !== null || officeCopyBusy();
if (init.recover && !init.readOnly) {
  const kept = await recovery.get(id);
  if (kept && kept.baseRevision <= revision) { source = kept.bytes; revision = contentRevision = kept.baseRevision; restored = true; }
} else if (!init.readOnly) await recovery.drop(id);
let historyBase: PdfHistoryBase = { revision: contentRevision, ...(restored ? { recovery: source } : {}) };
bindPdfHistory({
  writable: !init.readOnly,
  capture: () => historyBase,
  unsaved: () => restored || revision !== contentRevision,
  busyChanged: (busy) => post({ type: "office:dirty", dirty: busy || dirty }),
  async restore(base, load) {
    if (copying()) throw new Error("사본 저장을 마치거나 취소한 뒤 실행해 주세요.");
    if (init.readOnly) throw new Error("이 판은 읽기 전용입니다.");
    // Fetch before touching the active base. The save target remains the latest
    // revision; an old snapshot never rolls back the CAS or writes by itself.
    const bytes = base.recovery ?? await gateway.raw(id, base.revision);
    const before = { source, contentRevision, restored, historyBase };
    source = bytes; contentRevision = base.revision; historyBase = base;
    restored = !!base.recovery || revision !== contentRevision; epoch++;
    try { return await load(); }
    catch (error) {
      ({ source, contentRevision, restored, historyBase } = before); epoch++;
      throw error;
    }
  },
});
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
  if (pdfHistory.busy() || copying()) return "superseded";
  const before = epoch, baseRevision = revision;
  try {
    const bytes = await gateway.pdf<ArrayBuffer>(id, baseRevision, "recover", request, workingSource());
    if (epoch !== before) return "superseded";
    await queueRecovery(async () => { if (epoch === before) await recovery.put(id, { bytes, baseRevision, at: Date.now() }); });
    recoveryFailure = false; return epoch === before ? "written" : "superseded";
  } catch (error) { recoveryFailure = true; report(error); return "failed"; }
}
async function keep() {
  await pdfHistory.idle();
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
  if (copying()) { post({ type: "office:flushed", revision: null }); return; }
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      await pdfHistory.idle();
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
  if (message.type === "office:rebase") {
    if (copying()) post({ type: "office:flushed", revision: null });
    else void currentBytes().then(() => { revision = message.revision; return flush(); }).catch((error) => { report(error); post({ type: "office:flushed", revision: null }); });
  }
  if (message.type === "office:keep") void keep().catch(report).finally(() => post({ type: "office:flushed", revision: null }));
});

async function saveCopy(redaction = false) {
  if (copying()) throw new Error("이미 PDF 사본을 저장하고 있습니다.");
  if (pdfHistory.busy() || writing || flushing) throw new Error("PDF를 불러오거나 저장한 뒤 다시 시도해 주세요.");
  if (redaction && (init.readOnly || workingSource())) throw new Error("복원한 편집을 먼저 저장한 뒤 영구 가림 사본을 만들어 주세요.");
  copyOpening = true; epoch++;
  dispatch("pdf:save-as-flow", [true]);
  let turn: OfficeCopy | null = null;
  try {
    turn = await beginOfficeCopy(init, revision, "pdf");
    if (!turn) return false;
    const ready = turn;
    return await new Promise<boolean>((resolve) => {
      copyState = { turn: ready, redaction, finish: resolve };
      if (!redaction) ready.unlock(); // The original annotation-choice modal owns focus.
      dispatch("pdf:save-as-request", [ready.plan!.path]);
    });
  } finally {
    copyState = null; copyOpening = false;
    dispatch("pdf:save-as-flow", [false]); turn?.cancel();
  }
}
window.addEventListener("workbench:pdf-save-as", () => { void saveCopy().catch(report); });
window.addEventListener("keydown", (event) => {
  if (copying()) {
    // The original window shortcuts also run when a modal's radio/button has
    // focus. Keep native modal navigation, but never edit/save the source here.
    event.stopImmediatePropagation();
    if (event.key === "Tab" && copyState && !copyState.turn.locked) {
      const modal = document.querySelector('input[name="save-copy-annotations"]')?.closest(".pdf-modal");
      const controls = [...(modal?.querySelectorAll<HTMLElement>("input, button") ?? [])];
      if (controls.length) {
        event.preventDefault();
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
      return;
    }
    if (event.key === "Escape" && copyState && !copyState.turn.locked) {
      event.preventDefault();
      document.querySelector<HTMLInputElement>('input[name="save-copy-annotations"]')?.closest(".pdf-modal")?.querySelector<HTMLButtonElement>(".pdf-modal-actions button")?.click();
    } else if (event.ctrlKey || event.metaKey || !["Tab", "Enter", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "s") {
    event.preventDefault(); event.stopImmediatePropagation(); void saveCopy().catch(report);
  }
}, true);

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
  historyBase = { revision: next };
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
      if (pdfHistory.busy()) return { ok: false, error: "PDF를 불러오는 중입니다." };
      if (copying()) return { ok: false, error: "사본 저장을 마치거나 취소한 뒤 실행해 주세요." };
      writing++;
      try {
        const result = await gateway.pdf<{ revision: number }>(id, revision, transforms[channel], requestOf(args[0]), workingSource());
        await persistResult(result.revision); return { ok: true };
      } catch (error) { report(error); return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      finally { writing--; }
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
      case "pdf:request-redaction-copy": checkPath(args[0]); return saveCopy(true);
      case "pdf:save": {
        const request = requestOf(args[0]);
        if (request.targetPath !== undefined) {
          const current = copyState;
          try {
            if (!current || request.targetPath !== current.turn.plan?.path) throw new Error("먼저 PDF 사본 저장 위치를 선택해 주세요.");
            current.turn.lock();
            const { targetPath: _target, ...payload } = request;
            const bytes = await gateway.pdf<ArrayBuffer>(id, revision, current.redaction ? "redact-copy" : "copy", payload, workingSource());
            let originalRecovery: ArrayBuffer | null = null;
            if (!current.redaction && !(request.copyOnly === true && !workingSource()) && (dirty || workingSource())) {
              const { annotations: _annotations, copyOnly: _copyOnly, redactions: _redactions, ...edits } = payload;
              originalRecovery = await gateway.pdf<ArrayBuffer>(id, revision, "recover", edits, workingSource());
            }
            await recoveryQueue;
            // A redacted copy starts clean. Neither its artifact nor this clean
            // source receives an unredacted recovery payload from the copy flow.
            if (current.redaction) await recovery.drop(id);
            await current.turn.commit(bytes, originalRecovery, { keepSource: !current.redaction });
            return { ok: true, workbenchCopy: true };
          } catch (error) {
            current?.turn.cancel(); report(error);
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
        if (init.readOnly) return { ok: false, error: "이 판은 읽기 전용입니다." };
        if (pdfHistory.busy()) return { ok: false, error: "PDF를 불러오는 중입니다." };
        if (copying()) return { ok: false, error: "사본 저장을 마치거나 취소한 뒤 실행해 주세요." };
        writing++;
        try {
          const result = await gateway.savePdf(id, revision, request, workingSource());
          await persistResult(result.revision);
          return { ok: true, ...result };
        } catch (error) {
          await keepRequest(request);
          if (error instanceof GatewayError && error.status === 409) { post({ type: "office:conflict", code: error.code, message: error.message }); return { ok: false, error: "external-modified" }; }
          report(error); return { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally { writing--; }
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
    if (channel === "pdf:dirty-changed") { dirty = args[0] === true; post({ type: "office:dirty", dirty: dirty || pdfHistory.busy() }); }
    else if (channel === "pdf:close-save-result") closeAnswer?.(args[0] === true);
    else if (channel === "pdf:recovery-flush-done") recoveryAnswer?.();
    else if (channel === "pdf:save-as-result") copyState?.finish(args[0] === true);
  },
});
await import("@ieum/apps/pdf/src/preload/index.ts");
await import("@ieum/apps/pdf/src/renderer/main.tsx");
