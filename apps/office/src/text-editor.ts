import { mountOfficeAi } from "./office-ai.ts";
import { Events, Gateway, GatewayError, handshake, listen, post } from "./bridge.ts";
import { recovery } from "./recovery.ts";
import { configureTextAssets, resolveTextImage, unresolveTextImage } from "./text-assets.ts";
import { copyOfficeBytes, officeCopyBusy } from "./copy.ts";
import type { OfficeOutputFormat } from "../../../packages/contracts/src/office-output.ts";
import { htmlOutput } from "./output.ts";
import { preparePrintHtml } from "./print-html.ts";

/** The original Markdown/HTML renderers serialize their own source; never normalize it here. */
export async function createTextEditor(kind: "markdown" | "html") {
  const init = await handshake(), gateway = new Gateway(init.token), events = new Events();
  const ai = mountOfficeAi(init, gateway, events);
  const id = init.artifact.id, path = init.artifact.path;
  const assetBase = (await gateway.textAssets(id)).baseUrl;
  configureTextAssets(assetBase, path);
  const decode = (bytes: ArrayBuffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const encode = (text: string) => new TextEncoder().encode(text).buffer;
  const savedSource = decode(await gateway.raw(id, init.artifact.revision));
  let revision = init.artifact.revision, theme = init.theme, dirty = false, savedText = savedSource;
  let kept = init.recover && !init.readOnly ? await recovery.get(id) : undefined;
  if (kept && kept.baseRevision > revision) kept = undefined;
  if (!init.recover && !init.readOnly) await recovery.drop(id);
  if (kept) revision = kept.baseRevision;
  const recovered = kept ? { text: decode(kept.bytes), originalPath: path } : null;
  let recoveryQueue = Promise.resolve();
  const queueRecovery = (task: () => Promise<void>) => (recoveryQueue = recoveryQueue.catch(() => {}).then(task));
  const report = (error: unknown) => post({ type: "office:error", message: error instanceof Error ? error.message : String(error) });
  const setDirty = (value: boolean) => { dirty = value; post({ type: "office:dirty", dirty }); };
  let opened = false;
  function reportOpen() {
    if (opened) return;
    opened = true;
    post({ type: "office:opened", revision, recovered: Boolean(recovered) });
    if (recovered) setDirty(true);
  }

  let textAnswer: ((result: { text: string } | { error: string }) => void) | null = null;
  async function liveText(): Promise<string> {
    if (!events.has("readText")) throw new Error("편집기가 아직 문서를 여는 중입니다.");
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { textAnswer = null; reject(new Error("편집기에서 원문을 받지 못했습니다.")); }, 5000);
      textAnswer = (value) => { window.clearTimeout(timer); textAnswer = null; "text" in value ? resolve(value.text) : reject(new Error(value.error)); };
      events.emit("readText");
    });
  }
  async function keep(text?: string) {
    if (init.readOnly) return;
    const source = text ?? await liveText(), baseRevision = revision;
    await queueRecovery(() => recovery.put(id, { baseRevision, bytes: encode(source), at: Date.now() }));
  }

  let closeAnswer: ((ok: boolean) => void) | null = null;
  let flushing: Promise<void> | null = null;
  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        if (init.readOnly) { post({ type: "office:flushed", revision }); return; }
        const before = await liveText();
        if (!dirty && before === savedText) { post({ type: "office:flushed", revision }); return; }
        const ok = await new Promise<boolean>((resolve) => {
          const timer = window.setTimeout(() => { closeAnswer = null; resolve(false); }, 10_000);
          closeAnswer = (value) => { window.clearTimeout(timer); closeAnswer = null; resolve(value); };
          events.emit("closeSave");
        });
        // A save can finish while typing continues. Never acknowledge that newer buffer as saved.
        const after = await liveText();
        if (!ok || after !== savedText) { await keep(after); setDirty(true); post({ type: "office:flushed", revision: null }); }
        else { setDirty(false); post({ type: "office:flushed", revision }); }
      } catch (error) { report(error); post({ type: "office:flushed", revision: null }); }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  listen((message) => {
    if (message.type === "office:export-pdf") events.emit("export", "pdf");
    if (message.type === "office:theme") { theme = message.theme; events.emit("theme", theme); }
    if (message.type === "office:flush") void flush();
    if (message.type === "office:rebase") { revision = message.revision; void flush(); }
    if (message.type === "office:keep") void keep().catch(report).finally(() => post({ type: "office:flushed", revision: null }));
  });

  // Explicitly rejected integrations remain visible work. An absent service must not look like
  // an empty successful search, export, or model request, as the old generic null proxy did.
  const unavailable = (feature: string) => async () => { throw new Error(`${feature} 서비스를 연결하지 못했습니다.`); };
  const rejected = (feature: string) => async () => ({ ok: false, error: `${feature} 서비스를 연결하지 못했습니다.` });
  const prefsKey = `workbench.office.${kind}.prefs`;
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(localStorage.getItem(prefsKey) ?? "{}"); } catch { /* Ignore a damaged UI preference, never document data. */ }
  const remember = (key: string, value: unknown) => { prefs[key] = value; localStorage.setItem(prefsKey, JSON.stringify(prefs)); return value; };
  let previewQueue = Promise.resolve();
  const saveImage = async (data: { base64: string; ext: string }) => {
    if (init.readOnly) throw new Error("이 판은 읽기 전용입니다.");
    if (typeof data?.base64 !== "string" || data.base64.length > 70_000_000) throw new Error("그림 데이터의 크기 한도를 넘었습니다.");
    const binary = atob(data.base64), bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return gateway.saveImage(id, revision, bytes.buffer, `image.${data.ext}`);
  };
  const pickImage = () => new Promise<string | null>((resolve, reject) => {
    if (init.readOnly) { reject(new Error("이 판은 읽기 전용입니다.")); return; }
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/png,image/jpeg,image/gif";
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) { resolve(null); return; }
      try {
        if (file.size > 50 * 1024 * 1024) throw new Error("그림이 50MB를 넘습니다.");
        resolve(await gateway.saveImage(id, revision, await file.arrayBuffer(), file.name));
      } catch (error) { reject(error); }
    };
    input.click();
  });
  const api = {
    consumePending: async () => path,
    takeSeed: async () => null,
    takeNoteAppend: async () => [],
    onNoteAppendReady: events.on("noteAppend"),
    consumeHeadlessExport: async () => null,
    headlessExportDone: () => {},
    readFile: async (requested: string) => { if (requested !== path) throw new Error("열린 문서만 읽을 수 있습니다."); reportOpen(); return savedSource; },
    recoveryOpen: async () => { if (recovered) reportOpen(); return recovered; },
    writeRecoveryCopy: async (text: string | null) => { if (text !== null) await keep(text); return id; },
    onRecoveryFlushRequest: events.on("recoveryFlush"),
    save: async (request: { text: string; mode: "save" | "saveAs" }) => {
      if (request.mode === "save" && officeCopyBusy()) return { ok: false, error: "사본 저장을 마친 뒤 저장해 주세요." };
      if (init.readOnly) return { ok: false, error: "이 판은 읽기 전용입니다." };
      try {
        if (request.mode === "saveAs") {
          const format = path.split(".").at(-1)!.toLowerCase() as OfficeOutputFormat;
          const saved = await copyOfficeBytes(init, revision, format, async () => encode(request.text));
          return saved ? { ok: true, path: saved.path, writtenText: request.text } : { ok: false };
        }
        const saved = await gateway.saveText(id, revision, request.text);
        revision = saved.revision; savedText = request.text;
        await queueRecovery(() => recovery.drop(id));
        post({ type: "office:saved", revision });
        return { ok: true, path, writtenText: request.text };
      } catch (error) {
        await keep(request.text).catch(report);
        if (error instanceof GatewayError && error.status === 409) { post({ type: "office:conflict", code: error.code, message: error.message }); return { ok: false, error: "external-modified" }; }
        report(error); return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    setDirty,
    onSaveRequest: events.on("save"),
    sendSaveRequestAck: () => {},
    onReadTextRequest: events.on("readText"),
    sendReadTextResult: (value: { text: string } | { error: string }) => textAnswer?.(value),
    onCloseSaveRequest: events.on("closeSave"),
    sendCloseSaveResult: (ok: boolean) => closeAnswer?.(ok),
    onFileRenamed: events.on("renamed"),
    setProvisionalTitle: (title: string) => { document.title = title; },
    getLanguage: async () => "ko",
    onLanguageChanged: events.on("language"),
    getTheme: async () => theme,
    onThemeChanged: events.on("theme"),
    getDocumentTheme: async () => "follow",
    onDocumentThemeChanged: events.on("documentTheme"),
    getMarkdownTheme: async () => prefs.markdownTheme ?? "default",
    setMarkdownTheme: async (value: string) => remember("markdownTheme", value),
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
    onAutoSaveDefaultChanged: events.on("autoSave"),
    getAiPanelPrefs: async () => prefs.aiPanel ?? {},
    setAiPanelPrefs: async (patch: Record<string, unknown>) => { const value = { ...(prefs.aiPanel as object ?? {}), ...patch }; remember("aiPanel", value); events.emit("aiPanel", value); return value; },
    onAiPanelPrefsChanged: events.on("aiPanel"),
    onChromePressed: events.on("chrome"),
    onViewImage: events.on("image"),
    onExportRequest: events.on("export"),
    onPrintRequest: events.on("print"),
    ...ai.desktop,
    aiSubscription: ai.subscription, subscription: ai.subscription,
    webSearch: unavailable("웹 검색"), readUrl: rejected("웹 읽기"), imageSearch: unavailable("이미지 검색"),
    fetchImage: unavailable("이미지 다운로드"), aiGenerateImage: rejected("이미지 생성"),
    openSourcePath: unavailable("참조 문서 열기"), resolveWikiLinks: unavailable("위키 링크"),
    rememberWikiFragment: unavailable("위키 링크"), takeWikiFragment: async () => "",
    wikiBacklinks: unavailable("백링크"), wikiGraph: unavailable("그래프"),
    getImageHost: async () => null, setImageHost: unavailable("이미지 호스트"), uploadImage: rejected("이미지 업로드"),
    pickImage, saveImage,
    readImage: async (src: string) => {
      try { return await gateway.readImage(id, unresolveTextImage(src)); }
      catch (error) { if (error instanceof GatewayError && [400, 403, 404, 415].includes(error.status)) return null; throw error; }
    },
    saveImageAs: rejected("그림 저장"),
    exportDocx: rejected("Word 내보내기"), exportOdt: rejected("ODT 내보내기"), exportHtml: rejected("HTML 내보내기"),
    exportPdf: async (request: { html: string }) => {
      try {
        const job = await preparePrintHtml(request.html, { baseUrl: assetBase, ...(kind === "markdown" ? { imageUrl: resolveTextImage } : {}) });
        const result = await htmlOutput(revision, job, "html-pdf");
        return result?.path ? { ok: true, path: result.path } : { ok: true, canceled: true };
      } catch (error) { report(error); return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    prepareImageExport: rejected("그림 내보내기"), writeExportImage: rejected("그림 내보내기"), finishImageExport: rejected("그림 내보내기"),
    printHtml: async (request: { html: string }) => {
      try { await htmlOutput(revision, await preparePrintHtml(request.html, { baseUrl: assetBase }), "html-print"); return { ok: true }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    renderPrintPreview: async () => null,
    takeGenerateHandoff: async () => null, reportGenerateRunStarted: () => {},
    getPreviewInfo: () => gateway.previewInfo(id),
    updatePreview: (text: string) => (previewQueue = previewQueue.catch(() => {}).then(() => gateway.updatePreview(id, text))),
    setPresentFullScreen: async (on: boolean) => { if (on) await document.documentElement.requestFullscreen(); else if (document.fullscreenElement) await document.exitFullscreen(); },
    presentInNewTab: unavailable("새 탭 발표"),
  };
  return api;
}
