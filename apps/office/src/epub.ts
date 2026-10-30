import { mountOfficeAi, officeAiTransport } from "./office-ai.ts";
import { Gateway, GatewayError, handshake, listen, post } from "./bridge.ts";
import { recovery } from "./recovery.ts";
import { dispatch, useTransport } from "./platform/electron-renderer.ts";

type OpenBook = { status: string; sessionId?: string; assetBase?: string; restored?: boolean; [key: string]: unknown };
type EditResult = { ok: boolean; dirty?: boolean; workbenchGeneration?: number; [key: string]: unknown };
type Saved = { ok: true; revision: number; path: string; written: boolean; docHash: string; workbenchGeneration: number };
const init = await handshake(), gateway = new Gateway(init.token), id = init.artifact.id, path = init.artifact.path;
const ai = mountOfficeAi(init, gateway);
let revision = init.artifact.revision, theme = init.theme, session = "", restored = false, pending = false, backendDirty = false, generation = -1, epoch = 0, rebase = false;
let openPromise: Promise<OpenBook> | null = null, recoveryQueue = Promise.resolve();
const report = (error: unknown) => post({ type: "office:error", message: error instanceof Error ? error.message : String(error) });
const isDirty = () => restored || pending || backendDirty;
const changed = () => post({ type: "office:dirty", dirty: isDirty() });
const queueRecovery = (task: () => Promise<void>) => recoveryQueue = recoveryQueue.catch(() => {}).then(task);
const call = <T = unknown>(operation: string, args: unknown = {}) => gateway.epub<T>(id, session, operation, args);
function takeState(result: EditResult) {
  if (typeof result.workbenchGeneration === "number" && result.workbenchGeneration >= generation) {
    generation = result.workbenchGeneration; backendDirty = result.dirty === true;
  }
  changed();
}
async function checkpoint() {
  if (!session || init.readOnly) return;
  const before = epoch, kept = await gateway.epubCheckpoint(id, session);
  if (before !== epoch) return;
  await queueRecovery(async () => { if (before === epoch) await recovery.put(id, { bytes: kept.bytes, baseRevision: kept.baseRevision, at: Date.now() }); });
  if (before === epoch) await call("checkpoint-confirm", { checkpoint: kept.checkpoint });
}
let keeping: Promise<void> | null = null;
function keep(): Promise<void> {
  if (!session || init.readOnly) return Promise.resolve();
  if (keeping) return keeping;
  keeping = (async () => {
    await new Promise<void>((resolve, reject) => {
      const done = (event: Event) => {
        cleanup();
        (event as CustomEvent).detail === true ? resolve() : reject(new Error("입력 중인 내용을 보관하지 못했습니다. 편집 탭을 열어 두세요."));
      };
      const cleanup = () => { clearTimeout(timer); window.removeEventListener("workbench:epub:flushed", done); };
      const timer = window.setTimeout(() => { cleanup(); reject(new Error("전자책의 입력 반영을 기다리고 있습니다. 편집 탭을 열어 두세요.")); }, 15000);
      window.addEventListener("workbench:epub:flushed", done);
      window.dispatchEvent(new Event("workbench:epub:flush"));
    });
    await checkpoint();
  })().finally(() => { keeping = null; });
  return keeping;
}
let keepTimer: number | undefined;
function scheduleKeep() {
  clearTimeout(keepTimer);
  keepTimer = window.setTimeout(() => { if (isDirty()) void keep().catch(report); }, 1500);
}
let closeAnswer: ((ok: boolean) => void) | null = null, flushing: Promise<void> | null = null;
function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (!isDirty()) { post({ type: "office:flushed", revision }); return; }
      const ok = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => { closeAnswer = null; resolve(false); }, 20000);
        closeAnswer = (value) => { clearTimeout(timer); closeAnswer = null; resolve(value); };
        dispatch("epub:close-save-request", []);
      });
      if (!ok || isDirty()) { await keep(); post({ type: "office:flushed", revision: null }); }
      else post({ type: "office:flushed", revision });
    } catch (error) { report(error); post({ type: "office:flushed", revision: null }); }
  })().finally(() => { flushing = null; });
  return flushing;
}
listen((message) => {
  if (message.type === "office:theme") { theme = message.theme; dispatch("app:theme-changed", [theme]); }
  if (message.type === "office:flush") void flush();
  if (message.type === "office:rebase") { revision = message.revision; rebase = true; void flush(); }
  if (message.type === "office:keep") void keep().catch(report).finally(() => post({ type: "office:flushed", revision: null }));
});
window.addEventListener("pagehide", () => { clearTimeout(keepTimer); if (session) void gateway.closeEpub(id, session).catch(() => {}); });

const prefsBus = new BroadcastChannel("workbench.office.epub.view");
prefsBus.onmessage = (event) => dispatch("epub:view-prefs-changed", [event.data]);
let aiPrefs: Record<string, unknown> = {};
try { aiPrefs = JSON.parse(localStorage.getItem("workbench.office.epub.ai-prefs") ?? "{}"); } catch { /* preferences only */ }
useTransport({
  invoke: officeAiTransport(ai, dispatch, async (channel, args) => {
    switch (channel) {
      case "epub:consume-pending": return path;
      case "epub:open-file": {
        if (args[0] !== path) throw new Error("열린 전자책만 읽을 수 있습니다.");
        return openPromise ??= (async () => {
          const kept = init.recover && !init.readOnly ? await recovery.get(id) : null;
          if (kept && kept.baseRevision <= revision) { revision = kept.baseRevision; restored = true; }
          const opened = await gateway.openEpub<OpenBook>(id, revision, restored ? kept!.bytes : undefined);
          if (opened.status === "ok" && opened.sessionId) {
            session = opened.sessionId;
            opened.assetBase = new URL(opened.assetBase!, location.href).href;
            if (!restored && !init.readOnly) await recovery.drop(id);
            post({ type: "office:opened", revision, recovered: restored }); changed();
          } else if (restored) report(new Error("전자책 복구본을 열지 못했습니다. 보관된 사본은 그대로 남아 있습니다."));
          return opened;
        })();
      }
      case "epub:read-chapter": return call("chapter", { spineIndex: args[0] });
      case "epub:apply-edits": case "epub:replace-ranges": {
        const result = await call<EditResult>(channel === "epub:apply-edits" ? "apply" : "replace", args[0]);
        if (result.ok) { takeState(result); scheduleKeep(); }
        return result;
      }
      case "epub:set-translation-lock": return call("lock", { locked: args[0] });
      case "epub:save": {
        const request = args[0] as { mode?: string } | null;
        if (init.readOnly || request?.mode !== "save") return { ok: false, error: "이 저장 경로는 아직 연결하지 못했습니다." };
        try {
          const saved = await call<Saved>("save", { expectedRevision: revision, rebase });
          revision = saved.revision; restored = false; rebase = false; epoch++;
          takeState({ ok: true, dirty: false, workbenchGeneration: saved.workbenchGeneration });
          post({ type: "office:saved", revision }); changed();
          await queueRecovery(() => recovery.drop(id)).catch(report);
          if (isDirty()) scheduleKeep();
          return saved;
        } catch (error) {
          await checkpoint().catch(report);
          if (error instanceof GatewayError && error.status === 409) { post({ type: "office:conflict", code: error.code, message: error.message }); return { ok: false, error: "external-modified" }; }
          report(error); return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "epub:document-hash": return call("hash");
      case "epub:get-reading-state": return call("reading");
      case "epub:set-view-prefs": {
        const prefs = await call("prefs", { patch: args[0] }); prefsBus.postMessage(prefs); dispatch("epub:view-prefs-changed", [prefs]); return prefs;
      }
      case "app:get-language": return "ko";
      case "app:get-theme": return theme;
      case "app:get-auto-save-default": return { on: false, updatedAt: 0 };
      case "app:get-ai-panel-prefs": return aiPrefs;
      case "app:set-ai-panel-prefs": {
        if (args[0] && typeof args[0] === "object") aiPrefs = { ...aiPrefs, ...args[0] };
        localStorage.setItem("workbench.office.epub.ai-prefs", JSON.stringify(aiPrefs)); dispatch("app:ai-panel-prefs-changed", [aiPrefs]); return aiPrefs;
      }
      default: throw new Error(`전자책의 이 서비스를 아직 연결하지 못했습니다: ${channel}`);
    }
  }),
  send(channel, args) {
    if (channel === "epub:dirty-changed") { pending = args[0] === true; changed(); if (pending) scheduleKeep(); }
    if (channel === "epub:close-save-result") closeAnswer?.(args[0] === true);
    if (channel === "epub:set-read-position" && session) void call("position", { position: args[0] }).catch(report);
  },
});
await import("@ieum/apps/epub/src/preload/index.ts");
await import("@ieum/apps/epub/src/renderer/main.tsx");
