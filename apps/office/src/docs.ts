import { connectOfficeUi } from "./ui-adapters/connect.ts";
import { keepPaperWhite } from "./ui-adapters/paper.ts";
import "./docs.css";
import { Events, Gateway, GatewayError, handshake, headlessExport, listen, pageRest, post, stubBridge } from "./bridge.ts";
import { askHangulExport } from "./hangul-export.ts";
import { installInPlaceReplace, keepScroll } from "./replace-in-place.ts";
import { installViewPosition, readScroll, restoreScroll } from "./view-position.ts";
import { recovery } from "./recovery.ts";
import { convertForeignPictures, pasteDesktopPictures } from "./pictures.ts";
import { createOfficeAi } from "./office-ai.ts";
import { beginOfficeCopy, copyOfficeBytes, officeCopyBusy, type OfficeCopy } from "./copy.ts";
import { createOfficePreferences, legacyOfficePanel } from "./preferences.ts";
import { createDocsOutput } from "./docs-output.ts";
import { knowledgeNavigation } from "./knowledge.ts";
import { installMcp, originalMcp } from "./mcp.ts";
import { installSwap, swapInProgress } from "./swap.ts";

// IeumOffice's Word editor inside Workbench. The editor itself (vendor/ieumoffice/apps/docs,
// unchanged) reads and writes .docx in the page; this file stands in for its Electron preload:
// the document comes from a Workbench revision, a save becomes the next revision, and the
// original AI sidebar uses the same Workbench conversation as the surrounding window.

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const init = await handshake();
const headless = headlessExport(init);
const gateway = new Gateway(init.token);
const events = new Events();
const ai = createOfficeAi(init, gateway, events);
const preferences = await createOfficePreferences(init, gateway, (channel, value) => events.emit(({ "app:ai-panel-prefs-changed": "aiPanelPrefsChanged", "app:auto-save-default-changed": "autoSaveDefaultChanged", "app:document-theme-changed": "documentThemeChanged", "app:author-name-changed": "authorNameChanged" } as Record<string, string>)[channel] ?? channel, value), legacyOfficePanel("workbench.office.ai-panel"));
/** The document this page edits now: the editor pool may open another one in place (swap.ts), so it is read each time. */
const docId = () => init.artifact.id;
/** `revision`: the revision the editor's content is based on (a save must name it). `kept`: a recovery copy exists. */
const state = { revision: init.artifact.revision, theme: init.theme, dirty: false, kept: false };
connectOfficeUi(init, "word", command => events.emit("menuCommand", command), theme => {
  state.theme = theme; document.documentElement.dataset.workbenchTheme = theme; events.emit("themeChanged", theme);
});
let pendingOpen: Promise<unknown> | null = null;
let copyTurn: OfficeCopy | null = null;
const mcp = originalMcp(message => events.emit("mcpCommand", message));
let mcpCopy: OfficeCopy | null = null;
installMcp(init, {
  ready: mcp.ready, dirty: askDirty,
  async run(request) {
    if (request.kind === "read") return mcp.run("read_document");
    if (request.kind === "command" && request.family === "docx" && ["read_document", "insert_content", "replace_blocks", "apply_ops"].includes(request.command)) return mcp.run(request.command, request.payload);
    if (request.kind === "save" && request.plan) {
      mcpCopy = await beginOfficeCopy(init, state.revision, "docx", request.plan);
      if (!mcpCopy) throw new Error("저장을 취소했습니다.");
      return mcp.run("save_document", { path: request.plan.path, overwrite: request.plan.replace });
    }
    throw new Error("지원하지 않는 Word MCP 명령입니다.");
  },
  afterReply() { mcpCopy?.handoff(); mcpCopy?.cancel(); mcpCopy = null; },
});

document.documentElement.dataset.workbenchTheme = state.theme;

/** The revision as the editor wants a file (a one-shot URL to its bytes), or unsaved edits kept from an earlier visit. */
async function openResult() {
  let kept = init.recover && !init.readOnly ? await recovery.get(docId()).catch(() => undefined) : undefined;
  if (kept && kept.baseRevision > init.artifact.revision) kept = undefined;
  if (!kept && !init.readOnly) await recovery.drop(docId()).catch(() => undefined);
  if (kept) {
    state.revision = kept.baseRevision;
    state.kept = true;
  }
  const bytes = kept ? kept.bytes : await gateway.raw(docId(), state.revision);
  post({ type: "office:opened", revision: state.revision, recovered: Boolean(kept) });
  return {
    path: init.artifact.path,
    name: init.artifact.name,
    dataUrl: URL.createObjectURL(new Blob([bytes], { type: DOCX })),
    hash: init.artifact.sha256,
    recovered: Boolean(kept),
  };
}

/**
 * A new revision taken by the running editor (the 문서 AI's result from the executor, or one made
 * elsewhere): through the editor's own open path (its Electron "open this file" event), with the page's
 * scroll put back. Its undo history starts again at the new revision (the editor resets it on every
 * open), so 되돌리기 goes through the revision list (replace-in-place.ts).
 */
const editorScroll = () => document.querySelector<HTMLElement>(".editor-scroll");
function contentSwapped(timeoutMs = 15_000, quietMs = 300) {
  return new Promise<void>((resolve, reject) => {
    const target = () => document.querySelector(".editor-scroll .ProseMirror");
    let quiet: number | undefined, seen = false;
    const finish = (error?: Error) => { observer.disconnect(); window.clearTimeout(quiet); window.clearTimeout(limit); if (error) reject(error); else resolve(); };
    const observer = new MutationObserver(() => { seen = true; window.clearTimeout(quiet); quiet = window.setTimeout(() => finish(), quietMs); });
    observer.observe(document.querySelector(".editor-scroll") ?? document.body, { childList: true, subtree: true, characterData: true });
    const limit = window.setTimeout(() => (seen && target() ? finish() : finish(new Error("문서를 바꾸지 못했습니다."))), timeoutMs);
  });
}
let viewPlace: ReturnType<typeof installViewPosition> | null = null;
/** The tab keeps where the page was scrolled; a woken tab (or a document swapped in) opens there (office-leftovers point 3). */
function placeView() {
  if (init.execution || init.headlessExport) return;
  viewPlace?.dispose();
  viewPlace = installViewPosition({
    read: () => { const scroll = document.querySelector(".editor-scroll .ProseMirror") ? readScroll(editorScroll()) : undefined; return scroll ? { scroll } : null; },
    restore: (position) => Boolean(document.querySelector(".editor-scroll .ProseMirror")) && restoreScroll(editorScroll(), position.scroll),
  }, { initial: init.view, shown: () => pageRest.onScreen() && window.innerHeight > 0, post: (position) => post({ type: "office:view-position", position }) });
}
async function replaceInPlace(revision: number) {
  const place = viewPlace?.last();
  if (init.readOnly || !document.querySelector(".editor-scroll .ProseMirror")) throw new Error("편집기가 아직 준비되지 않았습니다.");
  const release = pageRest.hold("replace");
  try {
    const bytes = await gateway.raw(docId(), revision);
    const swapped = contentSwapped();
    await keepScroll(editorScroll, async () => {
      events.emit("openDocx", { path: init.artifact.path, name: init.artifact.name, dataUrl: URL.createObjectURL(new Blob([bytes], { type: DOCX })), hash: init.artifact.sha256, recovered: false });
      await swapped;
    });
    state.revision = revision;
    if (state.kept) { state.kept = false; void recovery.drop(docId()).catch(() => undefined); }
    // A hidden tab's page cannot set its scroll while it is not laid out: the place comes back when it is shown.
    viewPlace?.again(place);
  } finally { release(); }
}

async function save(data: ArrayBuffer) {
  if (swapInProgress()) return { ok: false, error: "다른 문서를 여는 중입니다. 잠시 뒤 저장해 주세요." };
  if (officeCopyBusy()) return { ok: false, error: "사본 저장을 마친 뒤 저장해 주세요." };
  if (init.readOnly) return { ok: false, error: "이 판은 읽기 전용입니다." };
  try {
    const saved = await gateway.saveBytes(docId(), state.revision, data);
    state.revision = saved.revision;
    if (state.kept) {
      state.kept = false;
      void recovery.drop(docId()).catch(() => undefined);
    }
    post({ type: "office:saved", revision: saved.revision });
    return { ok: true };
  } catch (error) {
    if (error instanceof GatewayError && error.status === 409) {
      // The editor stays dirty and says nothing about it (its Electron host would have asked); Workbench asks.
      post({ type: "office:conflict", code: error.code, message: error.message });
      return { ok: false, reason: "external-modified" as const, error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "office:error", message });
    return { ok: false, error: message };
  }
}

/** The editor has answered a dirty check at least once (state.dirty is its word, not the start value). */
let dirtyReported = false;
/** Ask the editor whether it has unsaved changes (its close check), for the Workbench header. */
const dirtyWaiters: ((dirty: boolean) => void)[] = [];
function askDirty(): Promise<boolean> {
  if (!events.has("closeCheck")) return Promise.resolve(false);
  return new Promise((resolve) => {
    dirtyWaiters.push(resolve);
    events.emit("closeCheck");
    window.setTimeout(() => resolve(state.dirty), 500);
  });
}

/** Recovery copies written for the document shown (the editor pool's park checks one was written). */
let keptWrites = 0;
/** A recovery copy right away (edits that could not be saved, when leaving the document). */
function keepNow(): Promise<void> {
  if (init.readOnly || !events.has("writeRecoveryNow")) return Promise.resolve();
  return new Promise((resolve) => {
    events.emit("writeRecoveryNow", () => resolve());
    window.setTimeout(resolve, 5000);
  });
}

/**
 * Save now (before a request is sent, the tab changes or the view switches), through the editor's
 * own save path. Edits that could not be saved are kept as a recovery copy instead.
 */
let closeSaveAnswer: ((ok: boolean) => void) | null = null;
async function flush() {
  if (init.readOnly || !(await askDirty())) return post({ type: "office:flushed", revision: state.revision });
  const ok = await new Promise<boolean>((resolve) => {
    closeSaveAnswer = resolve;
    events.emit("closeSaveRequest");
    window.setTimeout(() => resolve(false), 15_000);
  });
  if (!ok) await keepNow();
  post({ type: "office:flushed", revision: ok ? state.revision : null });
}

/** Keep my edits after a conflict: they become the revision after `revision` (the newer one stays in the history). */
async function rebase(revision: number) {
  if (!(await askDirty())) return post({ type: "office:flushed", revision: null });
  state.revision = revision;
  await flush();
}

/** The editor pool's hold on this page (swap.ts): park the document shown, open another in place. */
const swapEditor = {
  dirty: askDirty,
  lastDirty: () => (dirtyReported ? state.dirty : null),
  async keep() {
    // Where the view is goes to the tab before the frame is given away.
    viewPlace?.flush();
    const before = keptWrites;
    await keepNow();
    return keptWrites > before;
  },
  busy: () => officeCopyBusy() || closeSaveAnswer !== null || mcpCopy !== null || copyTurn !== null,
  async open() {
    // The old document's place is said no more: the new one's comes back first (installViewPosition restores before it reports).
    viewPlace?.dispose(); viewPlace = null;
    Object.assign(state, { revision: init.artifact.revision, dirty: false, kept: false }); dirtyReported = false;
    const result = await openResult();
    // The new document is shown as soon as its text is in (the page picture covers it until then); its layout may still settle.
    const swapped = contentSwapped(15_000, 80);
    events.emit("openDocx", result);
    await swapped.catch(() => undefined);
    placeView();
  },
};

listen((message) => {
  if (message.type === "office:export-pdf") events.emit("menuCommand", "export-pdf");
  if (message.type === "office:export-html") events.emit("menuCommand", "export-html");
  if (message.type === "office:export-images") events.emit("menuCommand", "export-images");

  if (message.type === "office:flush") void flush();
  if (message.type === "office:rebase") void rebase(message.revision);
  if (message.type === "office:keep") {
    void askDirty()
      .then((dirty) => (dirty ? keepNow() : undefined))
      .then(() => post({ type: "office:flushed", revision: null }));
  }
});

const notInWorkbench = async () => ({ ok: false, error: "Workbench에서는 대화창에서 요청하거나 문서 메뉴의 '새 문서로'를 써 주세요." });
const noAi = async () => {
  throw new Error("Workbench에서는 대화창에서 AI에게 요청하세요.");
};

const desktop = stubBridge(
  {
    getLanguage: async () => "ko",
    getSystemLocale: async () => "ko-KR",
    onLanguageChanged: events.on("languageChanged"),
    getTheme: async () => state.theme,
    onThemeChanged: events.on("themeChanged"),
    getDocumentTheme: async () => preferences.theme(),
    onDocumentThemeChanged: events.on("documentThemeChanged"),
    getAutoSaveDefault: async () => preferences.autoSave(),
    onAutoSaveDefaultChanged: events.on("autoSaveDefaultChanged"),
    getAuthorName: async () => preferences.name(),
    onAuthorNameChanged: events.on("authorNameChanged"),
    getAiPanelPrefs: async () => preferences.panel(),
    setAiPanelPrefs: (patch: object) => preferences.setPanel(patch),
    onAiPanelPrefsChanged: events.on("aiPanelPrefsChanged"),
    getRecentFiles: async () => [],
    consumePendingOpenDocx: async () => (pendingOpen ??= openResult().then((result) => {
      if (!init.readOnly && !init.execution && !init.headlessExport) installInPlaceReplace({ dirty: askDirty, replace: replaceInPlace });
      placeView();
      // The editor pool (swap.ts): this running editor may open the other Word documents of the window in place.
      if (!init.readOnly && !init.execution && !init.headlessExport) installSwap(init, gateway, ai, swapEditor);
      return result;
    })),
    consumeNewBlankDoc: async () => false,
    confirmDocumentReplace: async () => true,
    onOpenDocx: events.on("openDocx"),
    saveDocx: async (_path: string, data: ArrayBuffer) => save(data),
    saveDocxTo: async (path: string, bytes: ArrayBuffer, overwrite: boolean) => {
      if (!mcpCopy || mcpCopy.plan?.path !== path || mcpCopy.plan.replace !== overwrite) return { ok: false, error: "MCP 저장 위치를 확인하지 못했습니다." };
      const saved = await mcpCopy.commit(bytes, bytes, { deferHandoff: true });
      return { ok: true, path: saved.path };
    },
    saveDocxAs: async (target: string, bytes: ArrayBuffer) => {
      const turn = copyTurn; copyTurn = null;
      if (!turn || turn.plan?.path !== target) return { ok: false, error: "저장 위치를 다시 선택해 주세요." };
      try { const saved = await turn.commit(bytes); return { ok: true, path: saved.path }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      finally { turn.cancel(); }
    },
    saveDocxNew: async (_name: string, bytes: ArrayBuffer) => {
      try { const saved = await copyOfficeBytes(init, state.revision, "docx", async () => bytes); return saved ? { ok: true, path: saved.path } : { ok: false }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    pickSaveAsPath: async () => {
      copyTurn = await beginOfficeCopy(init, state.revision, "docx");
      return copyTurn?.plan ? { path: copyTurn.plan.path } : null;
    },
    // The editor's crash-recovery copy (every 30 s while dirty): kept in the browser until saved.
    writeRecoveryCopy: async (_path: string | null, data: ArrayBuffer) => {
      // While another document is being opened in place the editor still shows this one: nothing is written then.
      if (init.readOnly || swapInProgress()) return { ok: false };
      try {
        const id = docId(), base = state.revision;
        await recovery.put(id, { baseRevision: base, bytes: data, at: Date.now() });
        if (id === docId()) { state.kept = true; keptWrites += 1; }
        return { ok: true };
      } catch {
        return { ok: false, failed: true };
      }
    },
    onWriteRecoveryNow: events.on("writeRecoveryNow"),
    onCloseCheck: events.on("closeCheck"),
    reportCloseCheck: (report: { dirty: boolean }) => {
      // Mid-swap the answer is about the document going out: said to nobody.
      if (swapInProgress()) { for (const resolve of dirtyWaiters.splice(0)) resolve(report.dirty); return; }
      state.dirty = report.dirty; dirtyReported = true;
      post({ type: "office:dirty", dirty: report.dirty });
      for (const resolve of dirtyWaiters.splice(0)) resolve(report.dirty);
      // Edits undone back to the saved revision: the kept copy has nothing left to recover.
      if (!report.dirty && state.kept) {
        state.kept = false;
        void recovery.drop(docId()).catch(() => undefined);
      }
    },
    onCloseSaveRequest: events.on("closeSaveRequest"),
    reportCloseSaveResult: (ok: boolean) => {
      closeSaveAnswer?.(ok);
      closeSaveAnswer = null;
    },
    pickImage: () =>
      new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/gif";
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return resolve(null);
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          resolve({ base64: btoa(binary), mime: file.type || "image/png", name: file.name });
        };
        input.click();
      }),
    onMenuCommand: events.on("menuCommand"),
    ...createDocsOutput(() => state.revision),
    // "한글 문서로 내보내기" (v0.13.0's File menu item; ui-adapters/word.ts export-hwp): the window's dialog converts
    // this document as it is open (unsaved edits too) with docx2hwp on Workbench's one Hangul engine and asks
    // with the ledger before writing a NEW .hwpx/.hwp beside it. No answer with an error: the dialog said it.
    exportHwp: async (_name: string, docx: ArrayBuffer, _outPath?: string, passwordSet?: boolean) => {
      const result = await askHangulExport({ bytes: docx, passwordSet: passwordSet === true });
      return result.ok ? { ok: true, path: result.path } : { ok: false };
    },
    print: async () => {
      window.print();
      return { ok: true };
    },
    listPrinters: async () => [],
    spellDiag: () => undefined,
    armContextMenu: () => undefined,
    claimContextMenu: () => undefined,
    signalMcpReady: mcp.signal,
    reportMcpResult: mcp.result,
    onMcpCommand: events.on("mcpCommand"),
    reportViewMenuState: (state: { aiSidebar?: boolean }) => { if (typeof state?.aiSidebar === "boolean") post({ type: "office:ai-panel", open: state.aiSidebar }); },
    respondToZotero: () => undefined,
    consumeHeadlessExport: async () => headless.consume(),
    headlessExportDone: headless.done,
    docPasswordIntentRevision: async () => 0,
    discardDocPasswordIntents: async () => ({ ok: true }),
    fontFamilyInfo: async () => [],
    fontMetrics: async () => null,
    spellLanguages: async () => ({ available: [], enabled: [] }),
    // Legacy one-shot interface; current proofreading uses the original AI panel.
    aiChat: noAi,
    ...ai.desktop,
    openSourcePath: knowledgeNavigation(init.sessionId),
  },
  { listDocsTabs: [] },
  // HTML pieces inside a .docx are converted by a hidden Electron window; without one they are left as they are.
  ["convertAltChunkHtml"],
);

// The original project API is a projection of Workbench history. Other optional side
// bridges (Drive, outbound, user skills and document attachments) are connected separately.
Object.assign(window, { desktop, projectApi: ai.projectApi, aiOfficeSubscription: ai.subscription, aiOfficeDocs: ai.docs, aiOfficeDriveAi: ai.drive, workbenchOfficeAi: ai });
window.addEventListener("focus", () => { void ai.refresh().catch(() => {}); });

// The editor tells about unsaved changes when asked; ask now and then for the Workbench header.
window.setInterval(() => void askDirty(), 2000);

// Pictures in formats the editor does not take go on to it as PNG; a paste that shows the page
// nothing (a screenshot in WebKitGTK) gets the desktop clipboard's picture.
convertForeignPictures();
pasteDesktopPictures();

// The page stays white paper in the dark theme (the canvas around it goes dark) unless the person chose otherwise.
keepPaperWhite(localStorage);
await import("@ieum/apps/docs/src/renderer/main.tsx");
