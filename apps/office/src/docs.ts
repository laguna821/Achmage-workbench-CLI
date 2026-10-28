import "./docs.css";
import { Events, Gateway, GatewayError, handshake, listen, post, stubBridge } from "./bridge.ts";
import { recovery } from "./recovery.ts";

// IeumOffice's Word editor inside Workbench. The editor itself (vendor/ieumoffice/apps/docs,
// unchanged) reads and writes .docx in the page; this file stands in for its Electron preload:
// the document comes from a Workbench revision, a save becomes the next revision, and AI stays
// in Workbench's conversation (the editor's own AI panel, ribbon buttons and menu items are off).

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const init = await handshake();
const gateway = new Gateway(init.token);
const events = new Events();
const artifactId = init.artifact.id;
/** `revision`: the revision the editor's content is based on (a save must name it). `kept`: a recovery copy exists. */
const state = { revision: init.artifact.revision, theme: init.theme, dirty: false, kept: false };
let pendingOpen: Promise<unknown> | null = null;

document.documentElement.dataset.workbenchTheme = state.theme;

/** The revision as the editor wants a file (a one-shot URL to its bytes), or unsaved edits kept from an earlier visit. */
async function openResult() {
  let kept = init.recover && !init.readOnly ? await recovery.get(artifactId).catch(() => undefined) : undefined;
  if (kept && kept.baseRevision > init.artifact.revision) kept = undefined;
  if (!kept) await recovery.drop(artifactId).catch(() => undefined);
  if (kept) {
    state.revision = kept.baseRevision;
    state.kept = true;
  }
  const bytes = kept ? kept.bytes : await gateway.raw(artifactId, state.revision);
  post({ type: "office:opened", revision: state.revision, recovered: Boolean(kept) });
  return {
    path: init.artifact.path,
    name: init.artifact.name,
    dataUrl: URL.createObjectURL(new Blob([bytes], { type: DOCX })),
    hash: init.artifact.sha256,
    recovered: Boolean(kept),
  };
}

async function save(data: ArrayBuffer) {
  if (init.readOnly) return { ok: false, error: "이 판은 읽기 전용입니다." };
  try {
    const saved = await gateway.saveBytes(artifactId, state.revision, data);
    state.revision = saved.revision;
    if (state.kept) {
      state.kept = false;
      void recovery.drop(artifactId).catch(() => undefined);
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

listen((message) => {
  if (message.type === "office:theme") {
    state.theme = message.theme;
    document.documentElement.dataset.workbenchTheme = message.theme;
    events.emit("themeChanged", message.theme);
  }
  if (message.type === "office:flush") void flush();
  if (message.type === "office:rebase") void rebase(message.revision);
  if (message.type === "office:keep") {
    void askDirty()
      .then((dirty) => (dirty ? keepNow() : undefined))
      .then(() => post({ type: "office:flushed", revision: null }));
  }
});

// F7 runs the editor's AI proofreading; AI requests go through Workbench's conversation instead.
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "F7") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);

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
    getDocumentTheme: async () => "follow",
    onDocumentThemeChanged: events.on("documentThemeChanged"),
    // Every save is a revision: saved on Ctrl+S, before a request, when the tab or view changes; not on a timer.
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 1 }),
    onAutoSaveDefaultChanged: events.on("autoSaveDefaultChanged"),
    getAuthorName: async () => "",
    onAuthorNameChanged: events.on("authorNameChanged"),
    getAiPanelPrefs: async () => ({ side: "left", fontSize: "default", customFontSize: 14, spellcheck: true, openInNewDocs: false, showAiSidebar: false }),
    setAiPanelPrefs: async (patch: object) => ({ side: "left", fontSize: "default", customFontSize: 14, spellcheck: true, openInNewDocs: false, ...patch, showAiSidebar: false }),
    onAiPanelPrefsChanged: events.on("aiPanelPrefsChanged"),
    getAiSettings: async () => ({ provider: "auto", providers: {} }),
    getRecentFiles: async () => [],
    consumePendingOpenDocx: async () => (pendingOpen ??= openResult()),
    consumeNewBlankDoc: async () => false,
    confirmDocumentReplace: async () => true,
    onOpenDocx: events.on("openDocx"),
    saveDocx: async (_path: string, data: ArrayBuffer) => save(data),
    saveDocxAs: notInWorkbench,
    saveDocxNew: notInWorkbench,
    pickSaveAsPath: async () => null,
    // The editor's crash-recovery copy (every 30 s while dirty): kept in the browser until saved.
    writeRecoveryCopy: async (_path: string | null, data: ArrayBuffer) => {
      if (init.readOnly) return { ok: false };
      try {
        await recovery.put(artifactId, { baseRevision: state.revision, bytes: data, at: Date.now() });
        state.kept = true;
        return { ok: true };
      } catch {
        return { ok: false, failed: true };
      }
    },
    onWriteRecoveryNow: events.on("writeRecoveryNow"),
    onCloseCheck: events.on("closeCheck"),
    reportCloseCheck: (report: { dirty: boolean }) => {
      state.dirty = report.dirty;
      post({ type: "office:dirty", dirty: report.dirty });
      for (const resolve of dirtyWaiters.splice(0)) resolve(report.dirty);
      // Edits undone back to the saved revision: the kept copy has nothing left to recover.
      if (!report.dirty && state.kept) {
        state.kept = false;
        void recovery.drop(artifactId).catch(() => undefined);
      }
    },
    onCloseSaveRequest: events.on("closeSaveRequest"),
    reportCloseSaveResult: (ok: boolean) => {
      closeSaveAnswer?.(ok);
      closeSaveAnswer = null;
    },
    getPathForFile: (file: File) => file.name,
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
    print: async () => {
      window.print();
      return { ok: true };
    },
    listPrinters: async () => [],
    spellDiag: () => undefined,
    armContextMenu: () => undefined,
    claimContextMenu: () => undefined,
    signalMcpReady: () => undefined,
    reportMcpResult: () => undefined,
    reportViewMenuState: () => undefined,
    respondToZotero: () => undefined,
    headlessExportDone: () => undefined,
    docPasswordIntentRevision: async () => 0,
    discardDocPasswordIntents: async () => ({ ok: true }),
    fontFamilyInfo: async () => [],
    fontMetrics: async () => null,
    spellLanguages: async () => ({ available: [], enabled: [] }),
    // AI belongs to Workbench's conversation, not to the editor.
    aiChat: noAi,
    aiStream: noAi,
    aiToolCapabilities: async () => ({}),
  },
  { listDocsTabs: [], kbList: [] },
  // HTML pieces inside a .docx are converted by a hidden Electron window; without one they are left as they are.
  ["convertAltChunkHtml"],
);

// Only the editor's own bridge: the side bridges (AI drive, outbound, skills, split panes,
// document attach, projects) are all optional in the editor and are AI or shell features.
Object.assign(window, { desktop });

// The editor tells about unsaved changes when asked; ask now and then for the Workbench header.
window.setInterval(() => void askDirty(), 2000);

await import("@ieum/apps/docs/src/renderer/main.tsx");
