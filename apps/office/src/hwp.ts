import { Events, Gateway, GatewayError, handshake, listen, post } from "./bridge.ts";
import { recovery } from "./recovery.ts";
import type { HwpFormat, MeasuredTab, MemoSnapshot } from "../../../packages/contracts/src/hwp.ts";
import { encodeHwpSave } from "../../../packages/contracts/src/hwp.ts";
import type { OfficeOutputPlan, SvgJob } from "../../../packages/contracts/src/office-output.ts";
import { prepareOutput, commitOutput, printOutput } from "./output.ts";

// Ieum's HWP screen owns editing, tables, memos, selection and serialization. This bridge owns
// the Workbench revision, writer grant and recovery copy. No Electron main process is involved.
const init = await handshake();
const gateway = new Gateway(init.token), events = new Events();
const id = init.artifact.id, path = init.artifact.path;
const format: HwpFormat = /\.hwpx$/i.test(path) ? "hwpx" : "hwp";
const state = { revision: init.artifact.revision, theme: init.theme, dirty: false, kept: false, recovered: false, trackingDropped: false, saveBlocked: false, password: false, memoOpen: false, epoch: 0 };
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
  if (message.type === "office:theme") { state.theme = message.theme; events.emit("themeChanged", message.theme); }
  if (message.type === "office:flush") void flush();
  if (message.type === "office:rebase") {
    // Explicit user resolution; the overwritten revision remains in Workbench history.
    state.revision = message.revision;
    state.epoch++;
    void flush();
  }
  if (message.type === "office:keep") void keepNow().then(() => post({ type: "office:flushed", revision: null }));
});

const pendingFeature = async (): Promise<never> => { throw new Error("이 메뉴의 Workbench 연결을 준비 중입니다. 현재 문서와 편집 내용은 그대로 유지됩니다."); };
const panelPrefs = { side: "left", fontSize: "default", customFontSize: 14, spellcheck: true, openInNewDocs: false, showAiSidebar: false };
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
      saveTurn = { revision: state.revision, epoch: ++state.epoch, ...(output ? { output } : {}) };
      return { ok: true, path: output?.path ?? path, format: output?.format ?? format };
    } catch (error) { return reportFailure(error); }
  },
  newTabs: (bytes: Uint8Array, exportedFormat: HwpFormat) => {
    if (exportedFormat !== (saveTurn?.output?.format ?? format)) throw new Error("문서 형식이 바뀌었습니다.");
    return gateway.hwpTabs(id, saveTurn?.revision ?? state.revision, bytes, exportedFormat);
  },
  commitSave: async (bytes: Uint8Array, tabs?: MeasuredTab[], options?: { memos?: MemoSnapshot[] | null }) => {
    const turn = saveTurn;
    if (!turn || init.readOnly) return { ok: false, error: "저장 요청을 다시 시작하세요." };
    try {
      if (turn.output) {
        const saved = await commitOutput(turn.output.id, encodeHwpSave({ tabs, memos: options?.memos }, bytes));
        await recovery.drop(id).catch(() => undefined);
        state.kept = state.recovered = state.dirty = false;
        post({ type: "office:copied", artifactId: saved.artifactId });
        return { ok: true, path: saved.path };
      }
      const saved = await gateway.saveHwp(id, turn.revision, bytes, { tabs, memos: options?.memos });
      state.revision = saved.revision;
      state.epoch++;
      state.kept = state.recovered = state.dirty = false;
      await recovery.drop(id).catch(() => undefined);
      post({ type: "office:saved", revision: saved.revision });
      return { ok: true, path };
    } catch (error) { return reportFailure(error); }
    finally { if (saveTurn === turn) saveTurn = null; }
  },
  abortSave: () => { saveTurn = null; },
  setDirty: (dirty: boolean) => { state.dirty = dirty; post({ type: "office:dirty", dirty }); },
  onSaveRequest: events.on("saveRequest"),
  requestFileCommand: (command: string) => {
    if (command === "save" || command === "saveAs") events.emit("saveRequest", command);
    if (command === "print" || command === "pdf") events.emit("printRequest", command);
  },
  onPrintRequest: events.on("printRequest"),
  printPages: async (job: SvgJob & { mode: "print" | "pdf" }) => {
    try { const result = await printOutput(state.revision, job, job.mode); return { ok: true, ...(result ?? { canceled: true }) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  },
  onCloseSaveRequest: events.on("closeSaveRequest"),
  sendCloseSaveResult: (ok: boolean) => closeAnswer?.(ok),
  setMemoModalOpen: (open: boolean) => { state.memoOpen = open; },
  getMemoModalOpen: async () => state.memoOpen,
  onMemoBlocked: events.on("memoBlocked"),
  getAuthorName: async () => ({ value: "", fallback: "Workbench" }),
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
    return { restored: state.recovered, notice: password ? "암호 문서는 복구본을 만들지 않습니다." : null };
  },
  onRecoveryFlush: events.on("recoveryFlush"),
  sendRecoveryFlushed: (token: number) => recoveryWaiters.get(token)?.(),
  onRecoveryReset: events.on("recoveryReset"),
  getLanguage: async () => "ko",
  onLanguageChanged: events.on("languageChanged"),
  getTheme: async () => state.theme,
  onThemeChanged: events.on("themeChanged"),
  getAutoSaveDefault: async () => ({ on: false, updatedAt: 1 }),
  onAutoSaveDefaultChanged: events.on("autoSaveDefaultChanged"),
  getAiPanelPrefs: async () => panelPrefs,
  setAiPanelPrefs: async () => panelPrefs,
  onAiPanelPrefsChanged: events.on("aiPanelPrefsChanged"),
  // These explicitly incomplete ports remain in the parity ledger until shared AI services
  // are connected. Missing methods never silently report success.
  getAiSettings: async () => ({ provider: "auto", providers: {} }),
  setAiSettings: pendingFeature,
  onAiSettingsChanged: events.on("aiSettingsChanged"),
  openAiModelSettings: pendingFeature,
  aiSubscription: {
    statuses: async () => ({}), recheck: pendingFeature, login: pendingFeature, install: pendingFeature,
    update: pendingFeature, cancelLogin: pendingFeature, setMeteredAccepted: pendingFeature,
    onChanged: events.on("subscriptionChanged"), openInstallHelp: pendingFeature, openConnectHelp: pendingFeature,
  },
  aiStream: pendingFeature, aiStreamCancel: pendingFeature, onAiStream: events.on("aiStream"),
  readUrl: pendingFeature, imageSearch: pendingFeature, generateImage: pendingFeature, fetchImage: pendingFeature,
  aiToolCapabilities: async () => null,
  pickAttachments: pendingFeature, addAttachmentPaths: pendingFeature, addPastedImage: pendingFeature,
  readAttachment: pendingFeature, readAttachmentImage: pendingFeature,
  getPathForFile: (file: File) => file.name,
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
  hwpApi.requestFileCommand(key === "s" ? event.shiftKey ? "saveAs" : "save" : "print");
}
window.addEventListener("keydown", keys, true);
const bound = new WeakSet<HTMLIFrameElement>();
new MutationObserver(() => {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>(".hwp-editor-host iframe")) {
    if (bound.has(frame)) continue;
    bound.add(frame);
    const bind = () => frame.contentWindow?.addEventListener("keydown", keys, true);
    frame.addEventListener("load", bind); bind();
  }
}).observe(document.documentElement, { childList: true, subtree: true });

await import("@ieum/apps/hwp/src/renderer/main.tsx");
