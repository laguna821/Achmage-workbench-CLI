/** Transient state for the original Sheets/PDF/EPUB renderers. No document
 * content is interpreted or written here. The admitted child opens the saved
 * file through its normal bridge before these bindings become ready. */
export function bookExecutionJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type OriginalBookRequest = {
  schema: 1;
  request: { text: string; skillUse: { text: string; chips: unknown[] } };
};

/** Verify that the original send reconstructs exactly the admitted instruction.
 * This prevents applying the chosen skill text twice in the child renderer. */
export function readBookExecution<T extends OriginalBookRequest>(data: Record<string, unknown>, instruction: string): T {
  const value = bookExecutionJson(data);
  const request = value.request as Partial<OriginalBookRequest["request"]> | undefined;
  if (value.schema !== 1 || !request || typeof request.text !== "string" ||
      !request.skillUse || typeof request.skillUse.text !== "string" || !Array.isArray(request.skillUse.chips) ||
      request.text.trim() + request.skillUse.text !== instruction) {
    throw new Error("저장한 원본 문서 요청과 실행 요청이 일치하지 않습니다.");
  }
  return value as T;
}

export type BookSelectionBookmark = {
  start: number[]; startOffset: number; end: number[]; endOffset: number; text: string;
};

function nodePath(root: Node, node: Node): number[] | null {
  const path: number[] = [];
  while (node !== root) {
    const parent = node.parentNode;
    if (!parent) return null;
    const index = Array.prototype.indexOf.call(parent.childNodes, node) as number;
    if (index < 0) return null;
    path.unshift(index); node = parent;
  }
  return path;
}

function nodeAt(root: Node, path: number[]): Node | null {
  let node: Node | undefined = root;
  for (const index of path) {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    node = node?.childNodes[index];
    if (!node) return null;
  }
  return node ?? null;
}

/** A path bookmark distinguishes repeated passages, unlike a text search. */
export function captureBookSelection(doc: Document): BookSelectionBookmark | null {
  const selection = doc.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0), start = nodePath(doc.body, range.startContainer), end = nodePath(doc.body, range.endContainer);
  if (!start || !end) throw new Error("원본 EPUB 선택 범위를 저장할 수 없습니다.");
  return { start, startOffset: range.startOffset, end, endOffset: range.endOffset, text: selection.toString() };
}

/** Do not silently select a different occurrence when the saved DOM changed. */
export function restoreBookSelection(doc: Document, bookmark: BookSelectionBookmark | null): boolean {
  const selection = doc.getSelection();
  if (!selection) return bookmark === null;
  if (!bookmark) { selection.removeAllRanges(); return true; }
  if (!Array.isArray(bookmark.start) || !Array.isArray(bookmark.end) ||
      !Number.isSafeInteger(bookmark.startOffset) || bookmark.startOffset < 0 ||
      !Number.isSafeInteger(bookmark.endOffset) || bookmark.endOffset < 0 || typeof bookmark.text !== "string") return false;
  const start = nodeAt(doc.body, bookmark.start), end = nodeAt(doc.body, bookmark.end);
  if (!start || !end) return false;
  try {
    const range = doc.createRange();
    range.setStart(start, bookmark.startOffset); range.setEnd(end, bookmark.endOffset);
    if (range.toString() !== bookmark.text) return false;
    selection.removeAllRanges(); selection.addRange(range); return true;
  } catch { return false; }
}

export type EpubExecutionView = {
  spineIndex: number;
  visible: { firstId: string; lastId: string; first: number; last: number; total: number } | null;
  selection: string;
};
export type EpubExecutionContext = { view: EpubExecutionView; topBlockId: string | null; selection: BookSelectionBookmark | null };
export type EpubOriginalBinding = {
  ready(): boolean;
  capture(): EpubExecutionContext;
  restore(context: EpubExecutionContext): Promise<void>;
};
const epubBindings = new WeakMap<object, EpubOriginalBinding>();
export function bindOriginalEpub(host: object, binding: EpubOriginalBinding) { epubBindings.set(host, binding); }
export function originalEpubBinding(host: object) { return epubBindings.get(host); }

/** Inert only the document controls, preserving existing inert flags. Capture
 * also prevents a document-level Save/Undo shortcut from mutating the source
 * while the child holds its writer grant. Explicit chat Stop stays available. */
export function createOriginalBookLock(selectors: string) {
  const previous = new Map<HTMLElement, boolean>();
  let observer: MutationObserver | null = null;
  let locked = false;
  const apply = () => {
    for (const node of document.querySelectorAll<HTMLElement>(selectors)) {
      if (!previous.has(node)) previous.set(node, node.inert);
      node.inert = true;
    }
  };
  const keydown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="dialog"], [role="alertdialog"]') && target.closest('input, textarea, select, button, [contenteditable="true"]')) {
      // Native editing (including Undo) in a transcript question remains usable.
      // Do not let that shortcut also reach the original document's listener.
      if ((event.ctrlKey || event.metaKey) && /^[szyonp]$/i.test(event.key)) event.stopImmediatePropagation();
      return;
    }
    if (target?.closest(selectors) || (event.ctrlKey || event.metaKey) && /^[szyonp]$/i.test(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  return (value: boolean) => {
    if (locked === value) { if (locked) apply(); return; }
    locked = value;
    if (locked) {
      apply(); window.addEventListener("keydown", keydown, true);
      observer = new MutationObserver(apply); observer.observe(document.body, { childList: true, subtree: true });
    } else {
      observer?.disconnect(); observer = null; window.removeEventListener("keydown", keydown, true);
      for (const [node, inert] of previous) node.inert = inert;
      previous.clear();
    }
  };
}

type TranslationResult = {
  state: "cancelled" | "complete" | "stopped" | "failed";
  done?: number; total?: number; failedBlocks?: number; error?: string;
  outputs: { kind: string; path: string }[]; failures: string[];
};
let translation: {
  resolve(result: TranslationResult): void;
  outputs: TranslationResult["outputs"];
  failures: string[];
  recorded: boolean;
} | null = null;

/** Keep the original tool and parent turn alive through the original runner's
 * final write and unlock, not just until the person approves the dialog. */
export async function waitOriginalBookTranslation<T extends object>(open: () => T, executor: boolean): Promise<T & { workbenchTranslation?: TranslationResult }> {
  if (!executor) return open();
  if (translation) throw new Error("기존 EPUB 번역 확인이 끝나지 않았습니다.");
  let settle!: (result: TranslationResult) => void;
  const done = new Promise<TranslationResult>(resolve => { settle = resolve; });
  const pending = { resolve: settle, outputs: [] as TranslationResult["outputs"], failures: [] as string[], recorded: false };
  translation = pending;
  try {
    const answer = open();
    if (!("opened" in answer) || answer.opened !== true) return answer;
    return { ...answer, workbenchTranslation: await done };
  } finally { if (translation === pending) translation = null; }
}

export function recordOriginalBookOutputs(outputs: TranslationResult["outputs"], failures: string[]) {
  if (!translation) return;
  translation.outputs = bookExecutionJson(outputs); translation.failures = [...failures];
  translation.recorded = true;
}

export function finishOriginalBookTranslation(result: Omit<TranslationResult, "outputs" | "failures">) {
  if (!translation) return;
  const pending = translation;
  if (result.state === "complete" && !pending.recorded) pending.failures.push("원본 EPUB 결과 파일 저장을 확인하지 못했습니다.");
  const state = result.state === "complete" && (pending.failures.length > 0 || (result.failedBlocks ?? 0) > 0) ? "failed" : result.state;
  pending.resolve({ ...result, state, outputs: pending.outputs, failures: pending.failures });
}

/** The ordinary tool's "opened a window" output must not claim nothing ran
 * after an executor actually waited for that job to finish. */
export function originalBookTranslationResult(answer: object): { output: string; isError?: boolean } | null {
  if (!("workbenchTranslation" in answer)) return null;
  const result = answer.workbenchTranslation as TranslationResult;
  return {
    output: `Original EPUB translation result: ${JSON.stringify(result)}`,
    ...(result.state === "failed" ? { isError: true } : {}),
  };
}
