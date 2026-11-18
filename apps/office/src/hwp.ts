import { connectOfficeUi } from "./ui-adapters/connect.ts";
import { mountOfficeAi } from "./office-ai.ts";
import { createOfficePreferences, legacyOfficePanel } from "./preferences.ts";
import { Events, Gateway, GatewayError, handshake, listen, pageRest, post } from "./bridge.ts";
import { recovery } from "./recovery.ts";
import { installMcp } from "./mcp.ts";
import type { HwpFormat, HwpStructure, MeasuredTab, MemoSnapshot, SavePreview } from "../../../packages/contracts/src/hwp.ts";
import { encodeHwpSave, hwpPreviewWire } from "../../../packages/contracts/src/hwp.ts";
import { HANGUL_NOT_OFFERED, hangulFileCommand, hangulPrintLayout } from "./hwp-api-extras.ts";
import type { OfficeOutputPlan, SvgJob } from "../../../packages/contracts/src/office-output.ts";
import { prepareOutput, commitOutput, cancelOutput, printOutput } from "./output.ts";
import { installHwpEnhancements, pinStudioSkin } from "./hwp-enhancements.ts";
import { closeAiDockByDefault, installHwpAiDock, stepAsideForStudioDialogs } from "./hwp-ai-dock.ts";
import { showStudioToolboxByDefault } from "./ui-adapters/studio-bands.ts";
import { installHwpHold } from "./hwp-hold.ts";
import { installViewPosition, readScroll, restoreScroll } from "./view-position.ts";
import { onTurnActivity } from "./turn-activity.ts";

// Ieum's HWP screen owns editing, tables, memos, selection and serialization. This bridge owns
// the Workbench revision, writer grant and recovery copy. No Electron main process is involved.
const init = await handshake();
const gateway = new Gateway(init.token), events = new Events();
const ai = mountOfficeAi(init, gateway, events);
// The editor's own AI dock is the document's 문서 AI: the tab opens and closes it and hears its state.
const dock = installHwpAiDock(document, { post });
// While the AI works: only what must wait is held, it says so, and the hold always ends (hwp-hold.ts).
const hold = installHwpHold(document, { stop: (turnId) => ai.stop(turnId) });
Object.assign(window, { workbenchHwpHold: hold });
// "한글 문서 만들기": the dock's tool asks the gateway; what it made opens in its own tab when the
// turn ends (the executor's hidden page has no tab: the visible view opens what the turn reports).
const made = new Set<string>();
Object.assign(window, {
  workbenchHangulDocument: { make: (input: Record<string, unknown>, signal?: AbortSignal) => ai.hangulDocument(input, signal) },
  workbenchHangulMade: (artifactId: string) => { made.add(artifactId); },
});
if (!init.execution) {
  // A turn of this view's own loop: opened when it ends. An executor turn's end reloads this view
  // (office:execution-refresh) — an answer to a request sent now would come to a page that is gone,
  // so the reloaded view opens what it made (below).
  let remote = false;
  onTurnActivity((event) => {
    if (event.kind === "start") remote = false;
    if (event.kind === "remote") remote = true;
    if (event.kind !== "end") return;
    if (!remote) for (const artifactId of made) void ai.openMade(artifactId).catch(() => {});
    made.clear();
  });
}
// What a turn made while this view was being reloaded (an executor turn's end): opened now, once.
if (!init.execution && !init.readOnly) void (async () => {
  for (let n = 0; n < 5; n++) { const opened = await ai.openMade(null).catch(() => null); if (!opened?.ok) break; }
})();
const id = init.artifact.id, path = init.artifact.path;
const format: HwpFormat = /\.hwpx$/i.test(path) ? "hwpx" : "hwp";
const state = { revision: init.artifact.revision, theme: init.theme, dirty: false, kept: false, recovered: false, trackingDropped: false, saveBlocked: false, password: false, memoOpen: false, epoch: 0 };
connectOfficeUi(init, "hangul", command => {
  if (command === "save" || command === "save-as") events.emit("saveRequest", command === "save-as" ? "saveAs" : "save");
  // v0.13.0: print goes through the editor's print preview (인쇄 미리 보기); PDF still exports directly
  else hangulFileCommand(events, command === "export-pdf" ? "pdf" : "print");
}, theme => { state.theme = theme; events.emit("themeChanged", theme); });
installMcp(init, { ready: () => events.has("readBytesRequest"), dirty: () => state.dirty, async run(request) {
  if (request.kind !== "read") throw new Error("원본 한글 MCP는 읽기만 지원합니다.");
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const stop = events.on("readBytesResult")((raw) => {
      const result = raw as { ok?: boolean; bytes?: Uint8Array; error?: string };
      clearTimeout(timer); stop();
      if (result.ok && result.bytes instanceof Uint8Array) resolve(result.bytes); else reject(new Error(result.error || "한글 문서 내용을 받지 못했습니다."));
    });
    const timer = window.setTimeout(() => { stop(); reject(new Error("한글 문서 읽기 응답을 기다리지 못했습니다.")); }, 30_000);
    events.emit("readBytesRequest");
  });
  return gateway.liveHwpText(id, state.revision, bytes);
} });
let saveTurn: { revision: number; epoch: number; output?: OfficeOutputPlan } | null = null;
let recoveryTurn: { revision: number; epoch: number } | null = null;
let opening: Promise<Uint8Array> | null = null;
let closeAnswer: ((ok: boolean) => void) | null = null;
let flushNumber = 0;
const recoveryWaiters = new Map<number, () => void>();

async function open() {
  let kept = init.recover && !init.readOnly ? await recovery.get(id) : undefined;
  if (kept && kept.baseRevision > init.artifact.revision) kept = undefined;
  if (!init.recover && !init.readOnly) await recovery.drop(id);
  if (kept) { state.revision = kept.baseRevision; state.kept = state.recovered = true; }
  const opened = await gateway.openHwp(id, state.revision);
  state.trackingDropped = opened.trackingDropped;
  state.saveBlocked = opened.saveBlocked;
  return new Uint8Array(kept?.bytes ?? opened.bytes);
}

function reportFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GatewayError && (error.status === 409 || error.status === 423)) post({ type: "office:conflict", code: error.code, message });
  else post({ type: "office:error", message });
  return { ok: false as const, error: message };
}

async function keepNow() {
  if (init.readOnly || !events.has("recoveryFlush")) return;
  await new Promise<void>((resolve) => {
    const token = ++flushNumber;
    const finish = () => { clearTimeout(timer); recoveryWaiters.delete(token); resolve(); };
    const timer = window.setTimeout(finish, 10_000);
    recoveryWaiters.set(token, finish);
    events.emit("recoveryFlush", token);
  });
}

let flushing: Promise<void> | null = null;
async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    if (init.readOnly || !events.has("closeSaveRequest")) return post({ type: "office:flushed", revision: null });
    // Ask the editor even when the last dirty event said clean: the first keystroke and a
    // tab switch can happen in the same task, before a delayed state message arrives.
    const ok = await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => finish(false), 15_000);
      const finish = (ok: boolean) => { clearTimeout(timer); closeAnswer = null; resolve(ok); };
      closeAnswer = finish;
      events.emit("closeSaveRequest");
    });
    if (!ok) await keepNow();
    post({ type: "office:flushed", revision: ok ? state.revision : null });
  })().finally(() => { flushing = null; });
  return flushing;
}

listen((message) => {
  if (message.type === "office:export-pdf") events.emit("printRequest", "pdf");
  if (message.type === "office:flush") void flush();
  if (message.type === "office:rebase") {
    // Explicit user resolution; the overwritten revision remains in Workbench history.
    state.revision = message.revision;
    state.epoch++;
    void flush();
  }
  if (message.type === "office:keep") void keepNow().then(() => post({ type: "office:flushed", revision: null }));
  if (message.type === "office:ai-panel-set") dock.set(message.open, message.draft);
  if (message.type === "office:ai-draft-set") dock.put(message.draft);
});

const pendingFeature = async (): Promise<never> => { throw new Error("이 메뉴의 Workbench 연결을 준비 중입니다. 현재 문서와 편집 내용은 그대로 유지됩니다."); };
const preferences = await createOfficePreferences(init, gateway, (channel, value) => events.emit(({ "app:ai-panel-prefs-changed": "aiPanelPrefsChanged", "app:auto-save-default-changed": "autoSaveDefaultChanged", "app:document-theme-changed": "documentThemeChanged", "app:author-name-changed": "authorNameChanged" } as Record<string, string>)[channel] ?? channel, value), legacyOfficePanel("workbench.office.hwp.ai-prefs"));
const hwpApi = {
  consumePending: async () => path,
  untitledCopy: async () => null,
  readFile: async (requested: string) => {
    if (requested !== path) throw new Error("이 탭에 연결된 문서만 읽을 수 있습니다.");
    return opening ??= open();
  },
  trackingDropped: async () => state.trackingDropped,
  beginSave: async (mode: "save" | "saveAs") => {
    if (init.readOnly) return { ok: false, error: "읽기 전용 문서입니다." };
    if (state.memoOpen) { events.emit("memoBlocked"); return { ok: false, reason: "memo", error: "메모 작성을 마친 뒤 저장하세요." }; }
    if (state.saveBlocked) return { ok: false, reason: "tracked", error: "변경 추적을 보존할 수 없어 저장하지 않았습니다." };
    try {
      const output = mode === "saveAs" ? await prepareOutput(state.revision, format) : null;
      if (mode === "saveAs" && !output) return { ok: true, canceled: true };
      // Save As that picked PDF (v0.13.0): nothing is saved; the editor writes a PDF copy through printPages.
      if (output?.format === "pdf") { await cancelOutput(output.id).catch(() => {}); return { ok: true, path: output.path, export: "pdf" as const }; }
      saveTurn = { revision: state.revision, epoch: ++state.epoch, ...(output ? { output } : {}) };
      return { ok: true, path: output?.path ?? path, format: output?.format ?? format };
    } catch (error) { return reportFailure(error); }
  },
  newTabs: (bytes: Uint8Array, exportedFormat: HwpFormat) => {
    if (exportedFormat !== (saveTurn?.output?.format ?? format)) throw new Error("문서 형식이 바뀌었습니다.");
    return gateway.hwpTabs(id, saveTurn?.revision ?? state.revision, bytes, exportedFormat);
  },
  commitSave: async (bytes: Uint8Array, tabs?: MeasuredTab[], options?: { memos?: MemoSnapshot[] | null; structure?: HwpStructure | null; preview?: SavePreview | null }) => {
    const turn = saveTurn;
    if (!turn || init.readOnly) return { ok: false, error: "저장 요청을 다시 시작하세요." };
    // H10: the saved file's preview text and picture are the document as it is now (absent: as the engine wrote it)
    const preview = options && "preview" in options ? { preview: hwpPreviewWire(options.preview ?? null) } : {};
    try {
      if (turn.output) {
        const saved = await commitOutput(turn.output.id, encodeHwpSave({ tabs, memos: options?.memos, structure: options?.structure, ...preview }, bytes));
        await recovery.drop(id).catch(() => undefined);
        state.kept = state.recovered = state.dirty = false;
        post({ type: "office:copied", artifactId: saved.artifactId });
        return { ok: true, path: saved.path };
      }
      const saved = await gateway.saveHwp(id, turn.revision, bytes, { tabs, memos: options?.memos, structure: options?.structure, ...preview });
      state.revision = saved.revision;
      state.epoch++;
      state.kept = state.recovered = state.dirty = false;
      await recovery.drop(id).catch(() => undefined);
      post({ type: "office:saved", revision: saved.revision, ...(saved.text === "unchecked" || saved.structure === "unchecked" ? { unchecked: true } : {}) });
      return { ok: true, path };
    } catch (error) { return reportFailure(error); }
    finally { if (saveTurn === turn) saveTurn = null; }
  },
  abortSave: () => { if (saveTurn?.output) void cancelOutput(saveTurn.output.id).catch(() => {}); saveTurn = null; },
  setDirty: (dirty: boolean) => { state.dirty = dirty; post({ type: "office:dirty", dirty }); },
  onSaveRequest: events.on("saveRequest"),
  requestFileCommand: (command: string) => {
    if (command === "save" || command === "saveAs") events.emit("saveRequest", command);
    else hangulFileCommand(events, command);
  },
  onPrintRequest: events.on("printRequest"),
  // File > 인쇄 / 인쇄 미리 보기 and Ctrl+P (v0.13.0): the preview opens; printing from it comes back as printPages.
  onPreviewRequest: events.on("previewRequest"),
  // Printing goes through Workbench's print; a PDF through Workbench's PDF export (which asks where, also after a
  // Save As that picked PDF: `options.path` is that choice, the export's own dialog starts there).
  printPages: async (job: SvgJob & { mode: "print" | "pdf" }, _options?: { path: string }) => {
    try { const result = await printOutput(state.revision, job, job.mode); return { ok: true, ...(result ?? { canceled: true }) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  },
  // 고급 인쇄 (N-up, booklet, labels…) is not connected: the preview's plain Print and PDF stay.
  printLayout: hangulPrintLayout,
  // Upstream's command-line PDF export (--headless-export) runs in its own hidden window; Workbench's page never is one.
  consumeHeadlessExport: async () => null,
  headlessExportDone: () => {},
  onCloseSaveRequest: events.on("closeSaveRequest"),
  sendCloseSaveResult: (ok: boolean) => closeAnswer?.(ok),
  setMemoModalOpen: (open: boolean) => { state.memoOpen = open; },
  getMemoModalOpen: async () => state.memoOpen,
  onMemoBlocked: events.on("memoBlocked"),
  getAuthorName: async () => preferences.author(),
  onReadBytesRequest: events.on("readBytesRequest"),
  sendReadBytesResult: (result: unknown) => events.emit("readBytesResult", result),
  recoveryBegin: async () => {
    if (init.readOnly || state.password || saveTurn) return { ok: false };
    recoveryTurn = { revision: state.revision, epoch: state.epoch };
    return { ok: true, format };
  },
  recoveryNewTabs: (bytes: Uint8Array, exportedFormat: HwpFormat) => {
    if (exportedFormat !== format) throw new Error("복구본 형식이 바뀌었습니다.");
    return gateway.hwpTabs(id, recoveryTurn?.revision ?? state.revision, bytes);
  },
  recoveryWrite: async (bytes: Uint8Array, exportedFormat: HwpFormat, tabs: MeasuredTab[]) => {
    const turn = recoveryTurn;
    if (!turn || init.readOnly || state.password || exportedFormat !== format) return "refused";
    const valid = () => state.epoch === turn.epoch && state.revision === turn.revision && !saveTurn;
    if (!valid()) return "superseded";
    // A recovery export has no live memo snapshot: repair it without inventing a memo
    // deletion decision. A later real save still verifies the live snapshot before writing.
    const fixed = await gateway.repairHwp(id, turn.revision, bytes, { tabs });
    if (!valid()) return "superseded";
    await recovery.put(id, { baseRevision: turn.revision, bytes: fixed, at: Date.now() });
    if (!valid()) { await recovery.drop(id); return "superseded"; }
    state.kept = true;
    return "written";
  },
  recoveryOpened: async (password: boolean) => {
    state.password = password;
    post({ type: "office:opened", revision: state.revision, recovered: state.recovered });
    startViewPosition();
    return { restored: state.recovered, notice: password ? "암호 문서는 복구본을 만들지 않습니다." : null };
  },
  onRecoveryFlush: events.on("recoveryFlush"),
  sendRecoveryFlushed: (token: number) => recoveryWaiters.get(token)?.(),
  onRecoveryReset: events.on("recoveryReset"),
  getLanguage: async () => "ko",
  onLanguageChanged: events.on("languageChanged"),
  getTheme: async () => state.theme,
  onThemeChanged: events.on("themeChanged"),
  getAutoSaveDefault: async () => preferences.autoSave(),
  onAutoSaveDefaultChanged: events.on("autoSaveDefaultChanged"),
  getAiPanelPrefs: async () => preferences.panel(),
  setAiPanelPrefs: (patch: object) => preferences.setPanel(patch),
  onAiPanelPrefsChanged: events.on("aiPanelPrefsChanged"),
  ...ai.desktop,
  // What the Hangul AI is not offered (apps/office/hwp-offer-patch.ts) answers in words, should it be called.
  ...HANGUL_NOT_OFFERED,
  aiSubscription: ai.subscription,
  openDroppedDocuments: () => false,
};
Object.assign(window, { hwpApi });

// Electron's menu normally owns these shortcuts. Embedded rhwp deliberately gives them
// to its host; install the same commands on both the screen and the nested studio frame.
function keys(event: KeyboardEvent) {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key !== "s" && key !== "p") return;
  event.preventDefault(); event.stopImmediatePropagation();
  // Saving over the AI's half-made edit waits for the turn (printing only looks).
  if (key === "s" && hold.held()) { hold.flash(); return; }
  hwpApi.requestFileCommand(key === "s" ? event.shiftKey ? "saveAs" : "save" : "print");
}
window.addEventListener("keydown", keys, true);
const bound = new WeakSet<HTMLIFrameElement>();
new MutationObserver(() => {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>(".hwp-editor-host iframe")) {
    if (bound.has(frame)) continue;
    bound.add(frame);
    let stop = () => {};
    const bind = () => {
      frame.contentWindow?.addEventListener("keydown", keys, true);
      stop();
      const stopEnhancements = installHwpEnhancements(frame, init.token);
      const stopAside = frame.contentDocument ? stepAsideForStudioDialogs(document, frame.contentDocument) : () => {};
      const stopGuard = hold.guard(frame.contentWindow);
      stop = () => { stopEnhancements(); stopAside(); stopGuard(); };
    };
    window.addEventListener("pagehide", () => stop(), { once: true });
    frame.addEventListener("load", bind); bind();
  }
}).observe(document.documentElement, { childList: true, subtree: true });

pinStudioSkin(localStorage);
closeAiDockByDefault(localStorage);
showStudioToolboxByDefault(localStorage);
await import("@ieum/apps/hwp/src/renderer/main.tsx");

// The tab keeps where the studio's pages were scrolled; a woken tab opens there (office-leftovers point 3). The studio
// draws its pages as it scrolls, so the scroll is put back once its scroller has the document's height.
let viewPosition: ReturnType<typeof installViewPosition> | null = null;
function startViewPosition() {
  if (viewPosition || init.execution) return;
  const scroller = () => document.querySelector<HTMLIFrameElement>(".hwp-editor-host iframe")?.contentDocument?.getElementById("scroll-container") ?? null;
  viewPosition = installViewPosition({
    read: () => { const scroll = readScroll(scroller()); return scroll ? { scroll } : null; },
    restore: (position) => restoreScroll(scroller(), position.scroll),
  }, { initial: init.view, shown: () => pageRest.onScreen() && window.innerHeight > 0, post: (position) => post({ type: "office:view-position", position }) });
}
