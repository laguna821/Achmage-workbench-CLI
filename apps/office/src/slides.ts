import { connectOfficeUi } from "./ui-adapters/connect.ts";
import { createOfficePreferences, legacyOfficePanel } from "./preferences.ts";
import { mountOfficeAi, officeAiTransport } from "./office-ai.ts";
import "./slides.css";
import { Gateway, GatewayError, handshake, headlessExport, listen, pageRest, post } from "./bridge.ts";
import { installInPlaceReplace } from "./replace-in-place.ts";
import { dispatch, useTransport } from "./platform/electron-renderer.ts";
import { recovery } from "./recovery.ts";
import { carriesMark, convertForeignPictures, desktopPicture, markClipboard, pastedPicture, pngBytes, showsNothing } from "./pictures.ts";
import type { FontFaceBytes, WorkerCall, WorkerMessage, WorkerRequest } from "./slides/protocol.ts";
import { createSlideStyles } from "./slides/styles.ts";
import { templateFaces } from "./slides/template-fonts.ts";
import { beginOfficeCopy, copyOfficeBytes, officeCopyBusy, type OfficeCopy } from "./copy.ts";
import { installMcp } from "./mcp.ts";
import { prepareOutput, commitOutput, cancelOutput, renderHtmlPdf, htmlOutput } from "./output.ts";
import { preparePrintHtml } from "./print-html.ts";
import { buildPdfExportHtml, exportPageWidthIn, PDF_EXPORT_HEIGHT_IN } from "../../../third_party/ieumoffice/slides-print.ts";
import { buildPrintDocumentHtml } from "../../../vendor/ieumoffice/apps/slides/src/shared/print-html.ts";
import type { ExportPdfOp, PrintSlidesOp } from "../../../third_party/ieumoffice/slides-print.ts";
import type { OfficeOutputPlan } from "../../../packages/contracts/src/office-output.ts";
import { stampPdfLinks } from "./pdf-output-links.ts";
import { watchSlideDrawn } from "./slide-drawn.ts";
import { installViewPosition, readScroll, restoreScroll } from "./view-position.ts";

// IeumOffice's slides editor inside Workbench. Its screen (vendor/ieumoffice/apps/slides renderer)
// and its window API (the preload) are used unchanged; its editing code — pptx parsing, layout,
// edits, saving — runs in this page's worker (slides/worker.ts) instead of an Electron main
// process. The document comes from a Workbench revision and a save becomes the next revision; AI
// stays in Workbench's conversation.

const init = await handshake();
const headless = headlessExport(init);
const gateway = new Gateway(init.token);
const ai = mountOfficeAi(init, gateway);
const artifactId = init.artifact.id;
const styles = createSlideStyles(gateway, artifactId);
/** `revision`: what the editor's deck is based on (a save must name it). */
const state = { revision: init.artifact.revision, theme: init.theme, conflict: false, kept: false };
connectOfficeUi(init, "slides", command => dispatch("slides:menu", [command]), theme => {
  state.theme = theme; document.documentElement.dataset.workbenchTheme = theme; dispatch("app:theme-changed", [theme]);
});
let mcpCopy: OfficeCopy | null = null;
installMcp(init, {
  ready: () => value<boolean>({ type: "mcp", command: "ready" }), dirty: () => value<boolean>({ type: "dirty" }),
  async run(request) {
    if (request.kind === "read") return value({ type: "mcp", command: "read_deck" });
    if (request.kind === "command" && request.family === "pptx" && ["read_deck", "apply_slide_ops", "deck_withholds"].includes(request.command)) return value({ type: "mcp", command: request.command as "read_deck" | "apply_slide_ops" | "deck_withholds", payload: request.payload });
    if (request.kind === "save" && request.plan) {
      mcpCopy = await beginOfficeCopy(init, state.revision, "pptx", request.plan);
      if (!mcpCopy) throw new Error("저장을 취소했습니다.");
      return { ok: true, ...await mcpCopy.commit(await value<ArrayBuffer>({ type: "snapshot" }), undefined, { deferHandoff: true }) };
    }
    throw new Error("지원하지 않는 PPT MCP 명령입니다.");
  },
  afterReply() { mcpCopy?.handoff(); mcpCopy?.cancel(); mcpCopy = null; },
});

document.documentElement.dataset.workbenchTheme = state.theme;

// ── the worker ───────────────────────────────────────────────────────────
const worker = new Worker(new URL("./slides/worker.ts", import.meta.url), { type: "module" });
const waiting = new Map<number, { resolve(value: { value: unknown; unhandled?: boolean }): void; reject(error: Error): void }>();
let nextCall = 1;
// Template faces: the ones layout uses come from the worker as bytes with the message whose layout uses them, and are
// registered and loaded before that message reaches the editor; the others stay URL faces (below) until a text uses them.
const sentFaces = new Set<string>();
const urlFaces = new Map<string, FontFace>();
async function registerFaces(fonts: FontFaceBytes[]) {
  await Promise.all(fonts.map(async (font) => {
    const weight = font.weight ?? (font.bold ? "700" : "400"), style = font.italic ? "italic" : "normal";
    sentFaces.add(font.id);
    const url = urlFaces.get(`${font.family}|${weight}|${style}`);
    if (url) { document.fonts.delete(url); urlFaces.delete(`${font.family}|${weight}|${style}`); }
    try { const face = new FontFace(font.family, font.bytes, { weight, style }); document.fonts.add(face); await face.load(); } catch { /* the CSS fallback, as before */ }
  }));
  document.fonts.dispatchEvent(new Event("loadingdone"));
}
let delivering = Promise.resolve(), loading = 0;
worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  const fonts = message.type !== "notice" ? message.fonts : undefined;
  // Nothing loading: handled at once, as before. Otherwise in order behind the message whose faces are loading.
  if (!fonts?.length && !loading) return handleWorker(message);
  loading++;
  delivering = delivering
    .then(() => (fonts?.length ? registerFaces(fonts) : undefined))
    .then(() => handleWorker(message))
    .catch((error: unknown) => console.error(error))
    .finally(() => { loading--; });
};
function handleWorker(message: WorkerMessage) {
  if (message.type === "send") return dispatch(message.channel, message.args);
  if (message.type === "notice") return post({ type: "office:error", message: message.message });
  const waiter = waiting.get(message.id);
  if (!waiter) return;
  waiting.delete(message.id);
  if (message.ok) waiter.resolve({ value: message.value, unhandled: message.unhandled });
  else waiter.reject(new Error(message.error));
}
worker.onerror = (event) => post({ type: "office:error", message: `편집기 엔진 오류: ${event.message}` });

function call(request: WorkerRequest, transfer: Transferable[] = []) {
  const id = nextCall++;
  return new Promise<{ value: unknown; unhandled?: boolean }>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...request, id } as WorkerCall, transfer);
  });
}
const value = async <T>(request: WorkerRequest, transfer: Transferable[] = []) => (await call(request, transfer)).value as T;

// ── what the page answers itself ─────────────────────────────────────────
const preferences = await createOfficePreferences(init, gateway, (channel, value) => dispatch(channel, [value]), legacyOfficePanel("workbench.office.slides.ai-prefs"));
const noAi = () => Promise.reject(new Error("이 AI 도구는 아직 지원하지 않습니다."));
const unhandled = new Set<string>();
let pdfPlan: OfficeOutputPlan | null = null;

async function invoke(channel: string, args: unknown[]): Promise<unknown> {
  if (channel === "slides:consume-headless-export") return headless.consume()?.outPath ?? null;
  // A copy inside the editor: marked on the system clipboard now, while the key press or click lasts.
  if (channel === "slides:copy-elements" || channel === "slides:copy-slides") {
    copied.mark = markClipboard();
    copied.unmarked = copied.mark === null;
  }
  switch (channel) {
    case "app:get-language":
      return "ko";
    case "app:get-theme":
      return state.theme;
    case "app:get-auto-save-default": return preferences.autoSave();
    case "app:get-ai-panel-prefs": return preferences.panel();
    case "app:set-ai-panel-prefs": return preferences.setPanel(args[0]);
    case "slides:recent":
      return [];
    case "ai:insert-image-url":
    case "ai:replace-picture-url": {
      const op = args[0] as { base64?: string; ext?: string; url?: string };
      let base64 = op.base64;
      if (base64 == null) {
        // The host alone fetches public URLs and its generated-image cache. The
        // worker checks magic bytes, as the original image URL handlers do.
        const fetched = await ai.desktop.fetchImage(String(op.url));
        if (!fetched) return null;
        base64 = fetched.base64;
      } else if (!/^(png|jpe?g|gif)$/i.test(op.ext ?? "")) {
        // Original user attachments may be WebP/BMP/etc. Browser decoding replaces
        // Electron nativeImage's PNG conversion before the unchanged engine runs.
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const png = new Uint8Array(await pngBytes(new Blob([bytes], { type: `image/${op.ext ?? ""}` })));
        let binary = "";
        for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
        base64 = btoa(binary);
      }
      return value({ type: "invoke", channel, args: [{ ...op, base64 }] });
    }
    case "slides:open":
    case "slides:open-path":
      return null;
    case "slides:save":
      return save(args[0] === true);
    case "slides:pick-export-pdf-path":
      if (pdfPlan) await cancelOutput(pdfPlan.id);
      pdfPlan = await prepareOutput(state.revision, "pdf");
      return pdfPlan?.path ?? null;
    case "slides:export-pdf": {
      const op = args[0] as ExportPdfOp, plan = pdfPlan ?? (init.headlessExport ? await prepareOutput(state.revision, "pdf") : null); pdfPlan = null;
      if (!plan || op.filePath !== plan.path) return { ok: false, error: "PDF 저장 위치를 다시 선택해 주세요." };
      try {
        const widthIn = exportPageWidthIn(op.widthPx, op.heightPx), heightIn = PDF_EXPORT_HEIGHT_IN;
        const job = await preparePrintHtml(buildPdfExportHtml(op.pages, widthIn, heightIn, op.links, op.fontCss), { widthIn, heightIn, margin: 0 });
        const bytes = await stampPdfLinks(await renderHtmlPdf(state.revision, job), op.links ?? []);
        const result = await commitOutput(plan.id, bytes);
        return { ok: true, path: result.path };
      } catch (error) { await cancelOutput(plan.id); return { ok: false, error: String(error) }; }
    }
    case "slides:print": {
      try {
        const op = args[0] as PrintSlidesOp, layout = op.layout ?? "full", orientation = op.orientation ?? "portrait";
        const fullWidth = exportPageWidthIn(op.widthPx, op.heightPx);
        const html = buildPrintDocumentHtml({ srcs: op.pngsBase64.map(png => `data:image/png;base64,${png}`), ratio: fullWidth / PDF_EXPORT_HEIGHT_IN, layout, orientation, frame: op.frame, notes: op.notes });
        const widthIn = layout === "full" ? fullWidth : (orientation === "portrait" ? 210 : 297) / 25.4;
        const heightIn = layout === "full" ? PDF_EXPORT_HEIGHT_IN : (orientation === "portrait" ? 297 : 210) / 25.4;
        await htmlOutput(state.revision, await preparePrintHtml(html, { widthIn, heightIn, margin: 0 }), "html-print");
        return { ok: true };
      } catch (error) { return { ok: false, error: String(error) }; }
    }
    case "slides:save-as":
      try {
        const saved = await copyOfficeBytes(init, state.revision, "pptx", () => value<ArrayBuffer>({ type: "snapshot" }));
        return saved ? { ok: true, path: saved.path } : { ok: false };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    case "slides:native-clipboard":
      // Cut, copy and paste inside a text box are the page's own editing commands.
      document.execCommand(String(args[0]));
      return null;
    case "slides:private-font-faces": {
      const faces = await value<{ id: string }[]>({ type: "invoke", channel, args });
      return Array.isArray(faces) ? faces.filter((face) => !sentFaces.has(face.id)) : faces;
    }
    case "slides:consume-pending-open": {
      const opened = await value<unknown>({ type: "invoke", channel, args });
      // Unsaved edits reopened from a recovery copy count as unsaved.
      if (state.kept) await value({ type: "mark-dirty" });
      return opened;
    }
  }
  if (/^(ai|ai-subscription|subscription|project):/.test(channel)) return noAi();
  const reply = await call({ type: "invoke", channel, args, authorName: preferences.name() });
  if (reply.unhandled && !unhandled.has(channel)) {
    unhandled.add(channel);
    console.debug(`[workbench office] not provided: ${channel}`);
  }
  return reply.value;
}

let closeSaveAnswer: ((ok: boolean) => void) | null = null;
function send(channel: string, args: unknown[]) {
  if (channel === "slides:headless-export-done") { headless.done(args[0] as { ok?: boolean; error?: string }); return; }
  if (channel === "slides:close-save-result") {
    closeSaveAnswer?.(args[0] === true);
    closeSaveAnswer = null;
    return;
  }
  if (channel === "slides:autosave-pref") return;
  void call({ type: "send", channel, args }).catch(() => undefined);
}

useTransport({ invoke: officeAiTransport(ai, dispatch, (channel, args) => styles(channel, args, () => invoke(channel, args))), send });

// ── saving ───────────────────────────────────────────────────────────────
async function save(auto: boolean) {
  if (officeCopyBusy()) return { ok: false, error: "사본 저장을 마친 뒤 저장해 주세요." };
  if (state.conflict) return { ok: false, reason: "external-modified" };
  const result = await value<{ ok?: boolean; error?: string } | null>({ type: "invoke", channel: "slides:save", args: [auto] });
  if (!result?.ok) return result;
  const bytes = await value<ArrayBuffer>({ type: "saved-bytes" });
  try {
    const saved = await gateway.saveBytes(artifactId, state.revision, bytes);
    state.revision = saved.revision;
    if (state.kept) {
      state.kept = false;
      void recovery.drop(artifactId).catch(() => undefined);
    }
    post({ type: "office:saved", revision: saved.revision });
    return result;
  } catch (error) {
    // The editor counts the deck as saved; it was not taken as a revision, so it is unsaved again.
    await value({ type: "mark-dirty" });
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GatewayError && error.status === 409) {
      state.conflict = true;
      post({ type: "office:conflict", code: error.code, message });
      return { ok: false, reason: "external-modified", error: message };
    }
    post({ type: "office:error", message });
    return { ok: false, error: message };
  }
}

const isDirty = () => value<boolean>({ type: "dirty" }).catch(() => false);

/** A recovery copy right away (edits that could not be saved, or every 30 s while unsaved). */
async function keepNow() {
  const bytes = await value<ArrayBuffer | null>({ type: "snapshot" }).catch(() => null);
  if (!bytes) return;
  await recovery.put(artifactId, { baseRevision: state.revision, bytes, at: Date.now() }).catch(() => undefined);
  state.kept = true;
}

/** Save now through the editor's own save path (its close-save request); edits that could not be saved are kept. */
async function flush() {
  if (!(await isDirty())) return post({ type: "office:flushed", revision: state.revision });
  const ok = await new Promise<boolean>((resolve) => {
    closeSaveAnswer = resolve;
    dispatch("slides:close-save-request", []);
    window.setTimeout(() => resolve(false), 60_000);
  });
  if (!ok) await keepNow();
  post({ type: "office:flushed", revision: ok ? state.revision : null });
}

listen((message) => {
  if (message.type === "office:export-pdf") dispatch("slides:menu", ["export-pdf"]);
  if (message.type === "office:export-images") dispatch("slides:menu", ["export-images"]);

  if (message.type === "office:flush") void flush();
  if (message.type === "office:rebase") {
    void isDirty().then(async (dirty) => {
      if (!dirty) return post({ type: "office:flushed", revision: null });
      state.revision = message.revision;
      state.conflict = false;
      await flush();
    });
  }
  if (message.type === "office:keep") {
    void isDirty()
      .then((dirty) => (dirty ? keepNow() : undefined))
      .then(() => post({ type: "office:flushed", revision: null }));
  }
});

// Shortcuts the editor takes from its Electron app menu: here the page's keys send the same commands.
// Inside a text box, undo and the clipboard stay the text box's own.
const inText = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);

// ── pictures and text from other apps ────────────────────────────────────
// The editor pastes from its own clipboard (the worker's). What other apps copied reaches the page
// only in a paste event, so a paste outside a text box hands it over first; a paste that still
// carries the mark of the editor's last copy pastes that copy.
const copied: { mark: string | null; unmarked: boolean } = { mark: null, unmarked: false };
const pasting = { waiting: false };

async function pasteFrom(data: DataTransfer | null, trusted: boolean) {
  const own = Boolean(data && copied.mark && carriesMark(data, copied.mark));
  // A copy whose mark could not be written cannot be told from another app's: the editor's own wins.
  if (data && !own && !copied.unmarked) {
    // WebKitGTK shows a page no picture data: the user's paste of nothing visible asks the desktop clipboard.
    const picture = pastedPicture(data) ?? (trusted && showsNothing(data) ? await desktopPicture() : null);
    const text = picture ? "" : data.getData("text/plain");
    const png = picture ? await pngBytes(picture).catch(() => null) : null;
    if (png || text.trim()) {
      await value({ type: "clipboard", text: text || undefined, png: png ?? undefined }, png ? [png] : []);
      copied.mark = null;
    }
  }
  dispatch("slides:menu", ["paste"]);
}

// WebKit pastes outside editable text only when the page asks for it.
window.addEventListener("beforepaste", (event) => !inText(event.target) && event.preventDefault(), true);
window.addEventListener(
  "paste",
  (event) => {
    if (inText(event.target)) return;
    pasting.waiting = false;
    event.preventDefault();
    event.stopImmediatePropagation();
    void pasteFrom(event.clipboardData, event.isTrusted);
  },
  true,
);
// Dropped pictures in formats the editor does not take go on to it as PNG (pastes are handled above).
convertForeignPictures();
window.addEventListener(
  "keydown",
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    let command: string | null = null;
    if (key === "s") command = event.shiftKey ? "save-as" : "save";
    else if (key === "=" || key === "+") command = "zoom-in";
    else if (key === "-") command = "zoom-out";
    else if (key === "0") command = "zoom-reset";
    else if (!inText(event.target)) {
      if (key === "z") command = event.shiftKey ? "redo" : "undo";
      else if (key === "y") command = "redo";
      else if (key === "v" && !event.shiftKey) {
        // The browser's own paste follows with what was copied (above); without one, paste the editor's copy.
        event.stopPropagation();
        pasting.waiting = true;
        window.setTimeout(() => {
          if (!pasting.waiting) return;
          pasting.waiting = false;
          dispatch("slides:menu", ["paste"]);
        }, 80);
        return;
      } else if (key === "x" || key === "c" || key === "v") command = { x: "cut", c: "copy", v: "paste" }[key];
    }
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    dispatch("slides:menu", [command]);
  },
  true,
);

// The Workbench header shows whether there are unsaved edits (it keeps only changes); a copy is kept while there are.
window.setInterval(() => {
  void isDirty().then((dirty) => post({ type: "office:dirty", dirty }));
}, 2000);
window.setInterval(() => {
  void isDirty().then((dirty) => (dirty ? keepNow() : undefined));
}, 30_000);

// ── open the document, then the editor ──────────────────────────────────
let kept = init.recover && !init.readOnly ? await recovery.get(artifactId).catch(() => undefined) : undefined;
if (kept && kept.baseRevision > init.artifact.revision) kept = undefined;
if (!kept && !init.readOnly) await recovery.drop(artifactId).catch(() => undefined);
if (kept) {
  state.revision = kept.baseRevision;
  state.kept = true;
}
const bytes = kept ? kept.bytes : await gateway.raw(artifactId, state.revision);
await value({ type: "init", token: init.token });
await value({ type: "open", name: init.artifact.name, bytes }, [bytes]);
post({ type: "office:opened", revision: state.revision, recovered: Boolean(kept) });

// The bundled template families stay known to the page (the font list shows each name in its face, the design gallery
// draws them) as faces fetched only when some text on screen uses them. The faces layout measured with come as bytes
// through the private-font list (slides/fonts.ts), as before; the others are no longer read and decoded up front
// (all 17 were: 44 MB of font files in every PowerPoint tab).
for (const face of templateFaces) {
  const key = `${face.family}|${face.weight}|normal`;
  if (urlFaces.has(key)) continue;
  const url = new FontFace(face.family, `url(${face.url})`, { weight: face.weight, style: "normal" });
  urlFaces.set(key, url); document.fonts.add(url);
}
await import("@ieum/apps/slides/src/preload/index.ts");
await import("@ieum/apps/slides/src/renderer/main.tsx");
// The window's page picture leaves when the slide is drawn at its fitted place (not on "opened" or the AI panel's ready,
// which come before the slide: office-leftovers point 1).
if (!init.execution && !init.headlessExport) watchSlideDrawn(document, window, () => post({ type: "office:page-drawn" }));

/**
 * A new revision taken by the running editor (replace-in-place.ts): the worker opens it as the deck (its own
 * open path, as on opening), the renderer gets it through its own "opened" event (as an Electron open does),
 * and the slide that was on screen is shown again. The editor's undo history starts again at the new revision.
 */
let openGeneration = 0;
async function replaceInPlace(revision: number) {
  if (init.readOnly || !document.querySelector(".slide-list .thumb")) throw new Error("편집기가 아직 준비되지 않았습니다.");
  const release = pageRest.hold("replace");
  try {
    const thumbs = () => [...document.querySelectorAll<HTMLElement>(".slide-list .thumb")];
    const shown = Math.max(0, thumbs().findIndex((thumb) => thumb.classList.contains("active")));
    const list = document.querySelector<HTMLElement>(".slide-list"), listTop = list?.scrollTop ?? 0;
    const bytes = await gateway.raw(artifactId, revision);
    await value({ type: "open", name: init.artifact.name, bytes, generation: ++openGeneration }, [bytes]);
    const opened = await value<{ slides: unknown[] } | null>({ type: "invoke", channel: "slides:consume-pending-open", args: [1280] });
    if (!opened) throw new Error("새 판을 열지 못했습니다.");
    dispatch("slides:opened", [opened]);
    state.revision = revision; state.conflict = false;
    if (state.kept) { state.kept = false; void recovery.drop(artifactId).catch(() => undefined); }
    // The renderer starts at the first slide: the one that was on screen comes back (or the last one there is).
    const end = Date.now() + 3000;
    while (Date.now() < end && thumbs().length !== opened.slides.length) await new Promise((resolve) => setTimeout(resolve, 30));
    const target = thumbs()[Math.min(shown, thumbs().length - 1)];
    if (target && shown > 0) target.click();
    if (list) list.scrollTop = listTop;
  } finally { release(); }
}
if (!init.readOnly && !init.execution && !init.headlessExport) installInPlaceReplace({ dirty: isDirty, replace: replaceInPlace });
// The tab keeps the slide on screen and the slide list's scroll; a woken tab opens there (office-leftovers point 3).
// The slide is shown again the way a person does it (its thumbnail clicked), as replaceInPlace does.
if (!init.execution && !init.headlessExport) {
  const thumbs = () => [...document.querySelectorAll<HTMLElement>(".slide-list .thumb")];
  const list = () => document.querySelector<HTMLElement>(".slide-list");
  installViewPosition({
    read: () => {
      const all = thumbs();
      if (!all.length || document.querySelector(".start-booting")) return null;
      return { slide: Math.max(0, all.findIndex((thumb) => thumb.classList.contains("active"))), scroll: readScroll(list()) };
    },
    restore: (position) => {
      const all = thumbs();
      if (!all.length || document.querySelector(".start-booting")) return false;
      const index = Math.min(position.slide ?? 0, all.length - 1);
      if (index > 0 && !all[index]!.classList.contains("active")) { all[index]!.click(); return false; }
      return restoreScroll(list(), position.scroll) || (list()?.scrollHeight ?? 0) <= (list()?.clientHeight ?? 0);
    },
  }, { initial: init.view, shown: () => pageRest.onScreen() && window.innerHeight > 0, post: (position) => post({ type: "office:view-position", position }) });
}
