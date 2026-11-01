import { createOfficePreferences } from "./preferences.ts";
import { mountOfficeAi } from "./office-ai.ts";
import { Events, Gateway, GatewayError, handshake, headlessExport, listen, post } from "./bridge.ts";
import { recovery } from "./recovery.ts";
import { configureTextAssets, resolveTextImage, unresolveTextImage } from "./text-assets.ts";
import { copyOfficeBytes, officeCopyBusy } from "./copy.ts";
import type { OfficeOutputFormat } from "../../../packages/contracts/src/office-output.ts";
import { cancelOutput, commitGeneratedOutput, htmlOutput, prepareOutput, presentHtml, prepareImageOutput, writeImageOutput, finishImageOutput } from "./output.ts";
import { preparePrintHtml } from "./print-html.ts";
import { createOfficeWiki } from "./wiki.ts";
import { exportTextWord, markdownWordBytes } from "./text-word-output.ts";
import { installMcp } from "./mcp.ts";
import { createMarkdownSettings } from "./markdown-settings.ts";
import { noteRequests } from "./pdf-notes.ts";

/** The original Markdown/HTML renderers serialize their own source; never normalize it here. */
export async function createTextEditor(kind: "markdown" | "html") {
  const init = await handshake(), gateway = new Gateway(init.token), events = new Events();
  const headless = headlessExport(init);
  const ai = mountOfficeAi(init, gateway, events);
  const note = noteRequests(() => events.emit("noteAppend"));
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
  installMcp(init, { ready: () => opened && events.has("readText"), dirty: async () => dirty || await liveText() !== savedText,
    async run(request) { if (request.kind === "read") return liveText(); throw new Error("이 문서에는 읽기·저장·닫기 MCP만 사용할 수 있습니다."); } });
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
    if (message.type === "office:export-docx") events.emit("export", message.open && kind === "markdown" ? "docs" : "docx");
    if (message.type === "office:export-odt") events.emit("export", "odt");
    if (message.type === "office:export-html") events.emit("export", "html");
    if (message.type === "office:export-images" && kind === "markdown") events.emit("export", "png");
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
  const preferences = await createOfficePreferences(init, gateway, (channel, value) => events.emit(({ "app:ai-panel-prefs-changed": "aiPanel", "app:auto-save-default-changed": "autoSave", "app:document-theme-changed": "documentTheme" } as Record<string, string>)[channel] ?? channel, value), prefs.aiPanel);
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
  const readRemoteImage = (src: string) => gateway.aiSession(id).json<{ base64: string; mime: string } | null>("markdown-read-image", { src });
  const printOptions = { baseUrl: assetBase, ...(kind === "markdown" ? { imageUrl: resolveTextImage, readRemoteImage } : {}) };
  const api = {
    consumePending: async () => path,
    takeSeed: async () => null,
    takeNoteAppend: async () => kind === "markdown" && !init.readOnly ? note<string[]>("take") : [],
    onNoteAppendReady: events.on("noteAppend"),
    consumeHeadlessExport: async () => { const target = headless.consume(); return kind === "markdown" ? target?.outPath ?? null : target; },
    headlessExportDone: headless.done,
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
    getDocumentTheme: async () => preferences.theme(),
    onDocumentThemeChanged: events.on("documentTheme"),
    getMarkdownTheme: async () => prefs.markdownTheme ?? "default",
    setMarkdownTheme: async (value: string) => remember("markdownTheme", value),
    getAutoSaveDefault: async () => preferences.autoSave(),
    onAutoSaveDefaultChanged: events.on("autoSave"),
    getAiPanelPrefs: async () => preferences.panel(),
    setAiPanelPrefs: (patch: Record<string, unknown>) => preferences.setPanel(patch),
    onAiPanelPrefsChanged: events.on("aiPanel"),
    onChromePressed: events.on("chrome"),
    onViewImage: events.on("image"),
    onExportRequest: events.on("export"),
    onPrintRequest: events.on("print"),
    ...ai.desktop,
    aiSubscription: ai.subscription, subscription: ai.subscription,
    ...createOfficeWiki(init),
    ...(kind === "markdown" ? createMarkdownSettings(gateway, id, prefs.markdownTheme) : {}),
    pickImage, saveImage,
    readImage: async (src: string) => {
      if (kind === "markdown" && /^https?:\/\//i.test(unresolveTextImage(src))) return readRemoteImage(unresolveTextImage(src));
      try { return await gateway.readImage(id, unresolveTextImage(src)); }
      catch (error) { if (error instanceof GatewayError && [400, 403, 404, 415].includes(error.status)) return null; throw error; }
    },
    saveImageAs: rejected("그림 저장"),
    exportDocx: kind === "html"
      ? async (request: { html: string }) => (await import("./html-docx.ts")).exportHtmlDocx(revision, request.html, assetBase)
      : async (request: { base64: string; mode?: string }) => {
        // Opening the conversion retains this tab; protect its live draft without saving it.
        if (request.mode === "openInDocs") await keep();
        return exportTextWord(revision, "docx", async () => markdownWordBytes(request.base64), request.mode === "openInDocs");
      },
    exportOdt: kind === "html"
      ? async (request: { html: string }) => (await import("./html-docx.ts")).exportHtmlDocx(revision, request.html, assetBase, "odt")
      : (request: { base64: string }) => exportTextWord(revision, "odt", async () => markdownWordBytes(request.base64)),
    exportHtml: async (request: { html: string }) => {
      let generated: { id: string; revision: number; skipped: string[]; defaultName: string } | null = null, plan: { id: string } | null = null;
      try {
        generated = await gateway.exportSingleHtml(id, revision, request.html);
        plan = await prepareOutput(revision, "html", crypto.randomUUID(), { defaultName: generated.defaultName });
        if (!plan) return { ok: true, canceled: true };
        const result = await commitGeneratedOutput(plan.id, generated.id, generated.revision);
        return { ok: true, path: result.path, ...(generated.skipped.length ? { skipped: generated.skipped } : {}) };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      finally {
        if (plan) await cancelOutput(plan.id).catch(() => {});
        if (generated) await gateway.discardSingleHtml(id, generated.id).catch(() => {});
      }
    },
    exportPdf: async (request: { html: string }) => {
      try {
        const job = await preparePrintHtml(request.html, printOptions);
        const result = await htmlOutput(revision, job, "html-pdf");
        return result?.path ? { ok: true, path: result.path } : { ok: true, canceled: true };
      } catch (error) { report(error); return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    prepareImageExport: async (request: { html: string; suggestedName: string }) => {
      try {
        const job = await preparePrintHtml(request.html, printOptions);
        const prepared = await prepareImageOutput(revision, request.suggestedName, job);
        return prepared ? { ok: true, ...prepared } : { ok: true, canceled: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    writeExportImage: async (id: string, page: number, base64: string) => {
      try { return await writeImageOutput(id, page, base64); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    finishImageExport: async (id: string, success: boolean) => {
      try { return await finishImageOutput(id, success); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    printHtml: async (request: { html: string }) => {
      try { await htmlOutput(revision, await preparePrintHtml(request.html, printOptions), "html-print"); return { ok: true }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    renderPrintPreview: async () => null,
    takeGenerateHandoff: async () => null, reportGenerateRunStarted: () => {},
    getPreviewInfo: () => gateway.previewInfo(id),
    updatePreview: (text: string) => (previewQueue = previewQueue.catch(() => {}).then(() => gateway.updatePreview(id, text))),
    setPresentFullScreen: async (on: boolean) => { if (on) await document.documentElement.requestFullscreen(); else if (document.fullscreenElement) await document.exitFullscreen(); },
    presentInNewTab: async (title: string) => {
      try { await previewQueue; await keep(); await presentHtml(title, (await gateway.previewInfo(id)).url); return true; }
      catch (error) { report(error); return false; }
    },
  };
  return api;
}
