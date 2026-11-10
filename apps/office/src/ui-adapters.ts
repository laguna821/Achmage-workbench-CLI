import { hangulAdapter } from "./ui-adapters/hangul.ts";
import { wordAdapter } from "./ui-adapters/word.ts";
import { slidesAdapter } from "./ui-adapters/slides.ts";
import { sheetsAdapter } from "./ui-adapters/sheets.ts";
import { markdownAdapter } from "./ui-adapters/markdown.ts";
import { pdfAdapter } from "./ui-adapters/pdf.ts";
import { htmlAdapter } from "./ui-adapters/html.ts";
import { mindmapAdapter } from "./ui-adapters/mindmap.ts";
import { epubAdapter } from "./ui-adapters/epub.ts";
import "./ui-adapters.css";
import { installOfficeChrome } from "./ui-adapters/chrome.ts";

export type OfficeUiFormat = "hangul" | "word" | "slides" | "sheets" | "markdown" | "pdf" | "html" | "mindmap" | "epub";
export type UiTheme = "light" | "dark";
export type OfficeUiAdapter = { label: string; roots: string; frames?: string; commands: readonly (readonly [id: string, label: string, group?: string, shortcut?: string])[] };
export type EditorCommand = { id: string; label?: string; group?: string; shortcut?: string; run?: () => unknown; disabledReason?: () => string | null };
export type CommandPlacement = EditorCommand & { commandId: string; label: string; group: string };
export const officeUiAdapters: Record<OfficeUiFormat, OfficeUiAdapter> = {
  hangul: hangulAdapter, word: wordAdapter, slides: slidesAdapter, sheets: sheetsAdapter, markdown: markdownAdapter,
  pdf: pdfAdapter, html: htmlAdapter, mindmap: mindmapAdapter, epub: epubAdapter,
};

/** Placement never filters a renderer command, including advanced or newly added IDs. */
export function adaptOfficeCommands(format: OfficeUiFormat, existing: EditorCommand[]): CommandPlacement[] {
  const defaults = new Map(officeUiAdapters[format].commands.map(command => [command[0], command]));
  return existing.map(command => {
    const hint = defaults.get(command.id);
    return { ...command, commandId: command.id, label: command.label ?? hint?.[1] ?? command.id, group: command.group ?? hint?.[2] ?? "기타 명령", shortcut: command.shortcut ?? hint?.[3] };
  });
}

function controlDocuments(doc: Document, adapter: OfficeUiAdapter): Document[] {
  const result = [doc];
  if (adapter.frames) for (const frame of doc.querySelectorAll<HTMLIFrameElement>(adapter.frames)) {
    try { if (frame.contentDocument) result.push(frame.contentDocument); } catch { /* Cross-origin previews stay independent. */ }
  }
  return result;
}

/** Remember the original caret/range without serializing or rebuilding an editor. */
function rememberSelection(documents: Document[]): () => void {
  const snapshots = documents.map(doc => {
    const active = doc.activeElement as HTMLElement | null;
    const selection = doc.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const field = active && /^(INPUT|TEXTAREA)$/.test(active.tagName) ? active as HTMLInputElement | HTMLTextAreaElement : null;
    const caret = field && field.selectionStart !== null ? { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection } : null;
    return { doc, active, ranges, field, caret };
  });
  return () => {
    for (const { doc, active, ranges, field, caret } of snapshots) {
      if (active?.isConnected) active.focus({ preventScroll: true });
      if (ranges.length && ranges.every(range => range.startContainer.isConnected && range.endContainer.isConnected)) {
        const selection = doc.getSelection(); selection?.removeAllRanges(); ranges.forEach(range => selection?.addRange(range));
      }
      if (field?.isConnected && caret) field.setSelectionRange(caret.start, caret.end, caret.direction ?? undefined);
    }
  };
}

type MountedUi = { root: HTMLElement; theme: UiTheme; notify: (theme: UiTheme) => void; chrome: ReturnType<typeof installOfficeChrome> };
const mounted = new Map<string, MountedUi>();

/** Only UI state and the original theme event change. Document state stays in its renderer. */
export async function applyOfficeTheme(viewId: string, theme: UiTheme): Promise<{ remounted: false }> {
  const view = mounted.get(viewId);
  if (!view) throw new Error("편집기 UI가 아직 준비되지 않았습니다.");
  view.root.dataset.theme = theme;
  view.chrome.setTheme(theme);
  if (view.theme !== theme) { view.theme = theme; view.notify(theme); }
  return { remounted: false };
}

export function mountOfficeUi({ viewId, format, theme, onTheme, onCommand, doc = document }: {
  viewId: string; format: OfficeUiFormat; theme: UiTheme; onTheme: (theme: UiTheme) => void;
  onCommand: (id: string) => unknown; doc?: Document;
}) {
  const adapter = officeUiAdapters[format];
  const root = doc.createElement("div"); root.className = "wb-office-ui"; root.dataset.theme = theme;
  const dialog = doc.createElement("dialog"); dialog.className = "wb-office-commands"; dialog.setAttribute("aria-label", `${adapter.label} 편집 명령`);
  const header = doc.createElement("header"), title = doc.createElement("strong"); title.textContent = `${adapter.label} 편집 명령`;
  const dismiss = doc.createElement("button"); dismiss.type = "button"; dismiss.textContent = "닫기"; dismiss.setAttribute("aria-label", "편집 명령 닫기");
  header.append(title, dismiss);
  const input = doc.createElement("input"); input.type = "search"; input.placeholder = "명령 이름 찾기"; input.setAttribute("aria-label", "편집 명령 찾기");
  const summary = doc.createElement("p"); summary.className = "wb-office-command-status"; summary.setAttribute("role", "status");
  const results = doc.createElement("div"); results.className = "wb-office-command-list";
  dialog.append(header, input, summary, results); root.append(dialog); doc.body.append(root);
  const chrome = installOfficeChrome(doc, format, theme, () => controlDocuments(doc, adapter));
  const view = { root, theme, notify: onTheme, chrome }; mounted.set(viewId, view);
  let restore = () => {}, commands: CommandPlacement[] = [], filtered: CommandPlacement[] = [], composing = false;
  const ids = new WeakMap<Element, string>(); let nextId = 0;
  const collect = (): CommandPlacement[] => {
    const documents = controlDocuments(doc, adapter);
    const ready = documents.some(source => source.querySelector(adapter.roots));
    const native = adapter.commands.map(([id]) => ({ id, run: () => onCommand(id), disabledReason: () => ready ? null : "편집기를 여는 중입니다." }));
    const controls: EditorCommand[] = [];
    for (const source of documents) {
      const seen = new Set<Element>();
      for (const chrome of source.querySelectorAll(adapter.roots)) for (const element of chrome.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"], [role="tab"]')) {
        if (seen.has(element) || root.contains(element) || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) continue;
        seen.add(element);
        const label = (element.getAttribute("aria-label") || element.getAttribute("title") || element.dataset.tip || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!label) continue;
        let id = ids.get(element); if (!id) { id = `ribbon:${element.id || element.dataset.command || ++nextId}`; ids.set(element, id); }
        controls.push({ id, label, group: "현재 리본", run: () => element.click(), disabledReason: () => !element.isConnected ? "현재 리본에서 이 명령을 다시 선택해 주세요." : element.matches(":disabled, [aria-disabled=true]") ? element.dataset.disabledReason || "현재 선택에서는 사용할 수 없습니다." : null });
      }
    }
    return adaptOfficeCommands(format, [...native, ...controls]);
  };
  const close = () => { if (!dialog.open) return; dialog.close(); restore(); };
  const run = (command: CommandPlacement) => {
    const reason = command.disabledReason?.();
    if (reason) { summary.textContent = reason; return; }
    close();
    try { void Promise.resolve(command.run?.()).catch(reason => { show(); summary.textContent = String(reason); }); }
    catch (reason) { show(); summary.textContent = String(reason); }
  };
  const render = () => {
    const query = input.value.trim().toLocaleLowerCase();
    filtered = commands.filter(command => `${command.label} ${command.group} ${command.shortcut ?? ""}`.toLocaleLowerCase().includes(query));
    summary.textContent = filtered.length ? `${filtered.length}개 명령 · Alt+/로 열기` : "일치하는 명령이 없습니다. 원본 리본의 다른 탭을 연 뒤 다시 찾을 수 있습니다.";
    results.replaceChildren();
    for (const command of filtered) {
      const row = doc.createElement("button"); row.type = "button"; row.className = "wb-office-command"; row.dataset.commandId = command.commandId;
      const label = doc.createElement("span"); label.textContent = command.label;
      const hint = doc.createElement("small"); hint.textContent = [command.group, command.shortcut].filter(Boolean).join(" · ");
      row.append(label, hint);
      const reason = command.disabledReason?.();
      if (reason) { row.setAttribute("aria-disabled", "true"); const note = doc.createElement("small"); note.className = "wb-office-command-reason"; note.textContent = reason; row.append(note); }
      row.addEventListener("click", () => run(command)); results.append(row);
    }
  };
  const show = () => {
    if (dialog.open) { input.focus(); return; }
    const documents = controlDocuments(doc, adapter); documents.forEach(bind);
    restore = rememberSelection(documents); commands = collect(); input.value = ""; render();
    dialog.showModal(); input.focus({ preventScroll: true });
  };
  const keys = (event: KeyboardEvent) => {
    // Keep renderer-level shortcuts away from the search field, including plain Delete.
    // Browser defaults still edit this input and keep the native dialog's focus trap.
    if (dialog.open) event.stopImmediatePropagation();
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (!dialog.open) {
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "/" || event.code === "Slash")) { event.preventDefault(); event.stopImmediatePropagation(); show(); }
      return;
    }
    // Do not let a renderer's global editing shortcut change the document while searching.
    if (event.ctrlKey || event.metaKey) { event.stopImmediatePropagation(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    const rows = Array.from(results.querySelectorAll<HTMLButtonElement>("button"));
    const at = rows.indexOf(doc.activeElement as HTMLButtonElement);
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") || at >= 0 && (event.key === "Home" || event.key === "End")) {
      event.preventDefault(); event.stopImmediatePropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : at < 0 ? event.key === "ArrowUp" ? rows.length - 1 : 0 : event.key === "ArrowDown" ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
      rows[next]?.focus({ preventScroll: true }); rows[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && doc.activeElement === input) { event.preventDefault(); event.stopImmediatePropagation(); if (filtered[0]) run(filtered[0]); }
  };
  const documents = new Set<Document>();
  function bind(source: Document) { if (!documents.has(source)) { source.defaultView?.addEventListener("keydown", keys, true); documents.add(source); } }
  bind(doc);
  const frames = new Map<HTMLIFrameElement, () => void>();
  const bindFrames = () => {
    chrome.sync();
    if (!adapter.frames) return;
    for (const frame of doc.querySelectorAll<HTMLIFrameElement>(adapter.frames)) {
      if (frames.has(frame)) continue;
      const loaded = () => { chrome.sync(); controlDocuments(doc, adapter).forEach(bind); };
      frames.set(frame, loaded); frame.addEventListener("load", loaded);
    }
    controlDocuments(doc, adapter).forEach(bind);
  };
  bindFrames();
  const observe = adapter.frames ? new MutationObserver(bindFrames) : null;
  observe?.observe(doc.documentElement, { childList: true, subtree: true });
  input.addEventListener("input", render);
  input.addEventListener("compositionstart", () => { composing = true; }); input.addEventListener("compositionend", () => { composing = false; });
  dismiss.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("click", event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } });
  return { show, dispose() { close(); chrome.dispose(); observe?.disconnect(); frames.forEach((loaded, frame) => frame.removeEventListener("load", loaded)); documents.forEach(source => source.defaultView?.removeEventListener("keydown", keys, true)); root.remove(); if (mounted.get(viewId) === view) mounted.delete(viewId); } };
}
