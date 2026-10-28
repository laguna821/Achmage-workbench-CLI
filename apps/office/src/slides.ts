import "./slides.css";
import { Gateway, GatewayError, handshake, listen, post } from "./bridge.ts";
import { dispatch, useTransport } from "./platform/electron-renderer.ts";
import { recovery } from "./recovery.ts";
import { carriesMark, convertForeignPictures, markClipboard, pastedPicture, pngBytes } from "./pictures.ts";
import type { WorkerCall, WorkerMessage, WorkerRequest } from "./slides/protocol.ts";

// IeumOffice's slides editor inside Workbench. Its screen (vendor/ieumoffice/apps/slides renderer)
// and its window API (the preload) are used unchanged; its editing code — pptx parsing, layout,
// edits, saving — runs in this page's worker (slides/worker.ts) instead of an Electron main
// process. The document comes from a Workbench revision and a save becomes the next revision; AI
// stays in Workbench's conversation.

const init = await handshake();
const gateway = new Gateway(init.token);
const artifactId = init.artifact.id;
/** `revision`: what the editor's deck is based on (a save must name it). */
const state = { revision: init.artifact.revision, theme: init.theme, conflict: false, kept: false };

document.documentElement.dataset.workbenchTheme = state.theme;

// ── the worker ───────────────────────────────────────────────────────────
const worker = new Worker(new URL("./slides/worker.ts", import.meta.url), { type: "module" });
const waiting = new Map<number, { resolve(value: { value: unknown; unhandled?: boolean }): void; reject(error: Error): void }>();
let nextCall = 1;
worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.type === "send") return dispatch(message.channel, message.args);
  if (message.type === "notice") return post({ type: "office:error", message: message.message });
  const waiter = waiting.get(message.id);
  if (!waiter) return;
  waiting.delete(message.id);
  if (message.ok) waiter.resolve({ value: message.value, unhandled: message.unhandled });
  else waiter.reject(new Error(message.error));
};
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
const AI_OFF = { side: "left", fontSize: "default", customFontSize: 14, spellcheck: true, openInNewDocs: false, showAiSidebar: false };
const noAi = () => Promise.reject(new Error("Workbench에서는 대화창에서 AI에게 요청하세요."));
const unhandled = new Set<string>();

async function invoke(channel: string, args: unknown[]): Promise<unknown> {
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
    case "app:get-auto-save-default":
      // Every save is a revision: saved on Ctrl+S, before a request, when the tab or view changes.
      return { on: false, updatedAt: 1 };
    case "app:get-ai-panel-prefs":
    case "app:set-ai-panel-prefs":
      return AI_OFF;
    case "ai:get-settings":
      // The editor mounts its AI panel once settings arrive; they never do.
      return new Promise(() => {});
    case "slides:recent":
      return [];
    case "slides:open":
    case "slides:open-path":
      return null;
    case "slides:save":
      return save(args[0] === true);
    case "slides:save-as":
      return { ok: false, error: "Workbench에서는 대화창에서 요청하거나 '새 문서로'를 써 주세요." };
    case "slides:native-clipboard":
      // Cut, copy and paste inside a text box are the page's own editing commands.
      document.execCommand(String(args[0]));
      return null;
    case "slides:consume-pending-open": {
      const opened = await value<unknown>({ type: "invoke", channel, args });
      // Unsaved edits reopened from a recovery copy count as unsaved.
      if (state.kept) await value({ type: "mark-dirty" });
      return opened;
    }
  }
  if (/^(ai|ai-subscription|subscription|project):/.test(channel)) return noAi();
  const reply = await call({ type: "invoke", channel, args });
  if (reply.unhandled && !unhandled.has(channel)) {
    unhandled.add(channel);
    console.debug(`[workbench office] not provided: ${channel}`);
  }
  return reply.value;
}

let closeSaveAnswer: ((ok: boolean) => void) | null = null;
function send(channel: string, args: unknown[]) {
  if (channel === "slides:close-save-result") {
    closeSaveAnswer?.(args[0] === true);
    closeSaveAnswer = null;
    return;
  }
  if (channel === "slides:autosave-pref") return;
  void call({ type: "send", channel, args }).catch(() => undefined);
}

useTransport({ invoke, send });

// ── saving ───────────────────────────────────────────────────────────────
async function save(auto: boolean) {
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
  if (message.type === "office:theme") {
    state.theme = message.theme;
    document.documentElement.dataset.workbenchTheme = message.theme;
    dispatch("app:theme-changed", [message.theme]);
  }
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

async function pasteFrom(data: DataTransfer | null) {
  const own = Boolean(data && copied.mark && carriesMark(data, copied.mark));
  // A copy whose mark could not be written cannot be told from another app's: the editor's own wins.
  if (data && !own && !copied.unmarked) {
    const picture = pastedPicture(data);
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
    void pasteFrom(event.clipboardData);
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
    if (key === "s" && !event.shiftKey) command = "save";
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
if (!kept) await recovery.drop(artifactId).catch(() => undefined);
if (kept) {
  state.revision = kept.baseRevision;
  state.kept = true;
}
const bytes = kept ? kept.bytes : await gateway.raw(artifactId, state.revision);
await value({ type: "init", token: init.token });
await value({ type: "open", name: init.artifact.name, bytes }, [bytes]);
post({ type: "office:opened", revision: state.revision, recovered: Boolean(kept) });

await import("@ieum/apps/slides/src/preload/index.ts");
await import("@ieum/apps/slides/src/renderer/main.tsx");
