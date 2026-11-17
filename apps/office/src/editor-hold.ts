/**
 * Every editor while its document AI works (brief ux/briefs/office-ai-live-brief.md, point 2): the Hangul
 * treatment (hwp-hold.ts) for Word, PowerPoint, Excel, PDF, Markdown and HTML.
 *
 * Until 0.5.3 their executor adapters made the page and the ribbon `inert` from "sent" to the end of the
 * turn: nothing could be scrolled, selected, zoomed or clicked, and nothing said why. Now:
 * - LOOKING is never held: scroll, zoom, page / slide / sheet navigation, select and copy, find, the
 *   ribbon's tab headers and its view controls, the 문서 AI panel, dialogs.
 * - TYPING and the controls that change or save the document wait — only while they must: from "sent"
 *   when the turn runs in the independent executor (it owns the saved file for the turn), from the AI's
 *   first edit when it runs in this page (the live path).
 * - One quiet line on the editor says so, with 중단; a refused key or click makes the line noticed.
 * - The hold always ends: the same state and words as the Hangul page (createHoldState: finished,
 *   failed, stopped, engine died, gateway lost, no sign of life → 응답이 없습니다 · 중단 / 계속 기다리기,
 *   tab woke, 중단 unanswered).
 *
 * Shared with the Hangul page: the state, the words, the look-only keys. Its own: the shapes of these
 * editors (where the document is, where the ribbon is) and the naming rule for their controls (they have
 * no command ids like the Hangul studio's data-cmd).
 */
import { HOLD_WORDS, STOP_GRACE_MS, createHoldState, keyOnlyLooks, type HoldState } from "./hwp-hold.ts";
import { HWP_EDIT_TOOLS, onTurnActivity } from "./turn-activity.ts";

export type EditorHoldShape = {
  /** the document itself (pages, slides, grid) and what sits with it: buttons here look unless named as a change */
  surface: string;
  /** ribbons, toolbars, formula bars: controls here change unless named as looking (or a tab header) */
  chrome: string;
  /** where arrow keys move something in the document (a selected shape) instead of the view */
  arrowsChange?: string;
};
export type EditorHoldFormat = "word" | "slides" | "sheets" | "pdf" | "markdown" | "html";
export const EDITOR_HOLD_SHAPES: Record<EditorHoldFormat, EditorHoldShape> = {
  word: { surface: ".app-content", chrome: ".ribbon" },
  slides: { surface: ".app-content", chrome: ".ribbon", arrowsChange: ".stage-wrap, .stage-col" },
  sheets: { surface: "#univer-container, .sheet-main", chrome: ".excel-header, .formula-bar" },
  pdf: { surface: ".app-content", chrome: ".ribbon" },
  markdown: { surface: ".app-content", chrome: ".ribbon" },
  html: { surface: ".app-content", chrome: ".ribbon" },
};

/** Tools of these editors that only read, plan or look things up; any other tool changes the document. */
const READS = /^(read_|get_|list_|find_|search_|trace_|check_|plan_|load_guide$|analyze_media$|web_search$|image_search$|ask_clarification$|use_skill$|read_skill_file$|aggregate_range$|select_range$|goto_page$|make_hangul_document$)/;
export function toolEditsDocument(name: string): boolean {
  return HWP_EDIT_TOOLS.has(name) || !READS.test(name);
}

const CHANGES = /바꾸기|교체|삽입|삭제|붙여넣기|잘라내기|설정|서식|스타일|적용|추가|정렬|채우기|병합|나누기|저장|실행 취소|다시 실행|되돌리기|지우기|복제|새로 만들기|만들기|변경|편집|굵게|기울임|밑줄|취소선|글꼴|들여쓰기|내어쓰기|번호 매기기|글머리/;
const LOOKS = /보기|확대|축소|배율|화면 맞춤|맞춤 보기|찾기|검색|복사|인쇄|내보내기|다음|이전|처음으로|마지막으로|이동|전체 화면|발표|슬라이드 쇼|눈금자|격자|탐색|개요|접기|펼치기|문서 AI|zoom|view|find|search|copy|print|export|present|next|prev/i;
/** A control named as looking (view, zoom, find, copy, print, export, navigation); a change word wins. */
export function controlOnlyLooks(label: string): boolean {
  return !CHANGES.test(label) && LOOKS.test(label);
}

const PANEL = ".ai-dock, .ai-panel, .copilot";
const DIALOG = '[role="dialog"], [role="alertdialog"], .modal-overlay, .dialog-wrap';
const MENU = '[role="menu"], [role="menubar"], [role="listbox"]';
const CONTROL = 'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], select, input[type="checkbox"], input[type="radio"], a[href]';
const TAB = '.ribbon-tab, [role="tab"]';
const TEXT_INPUT = 'input:not([type]), input[type="text"], input[type="search"], input[type="number"]';

const STYLE = `
.wb-ai-hold{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:8px;
  padding:6px 8px 6px 14px;border:1px solid var(--wb-ui-line-strong);border-radius:var(--wb-ui-radius-card);background:var(--wb-ui-bg);
  color:var(--wb-ui-text);font:var(--wb-ui-text-sm) var(--wb-ui-font);box-shadow:0 2px 0 var(--wb-ui-line)}
.wb-ai-hold[hidden]{display:none}
.wb-ai-hold[data-flash]{outline:2px solid var(--wb-ui-focus);outline-offset:1px}
.wb-ai-hold button{font:inherit;color:var(--wb-ui-text);background:var(--wb-ui-group);border:1px solid var(--wb-ui-line);
  border-radius:var(--wb-ui-radius-key);padding:2px 10px;cursor:pointer}
.wb-ai-hold button:hover{background:var(--wb-ui-hover)}
.wb-ai-hold button:focus-visible{outline:2px solid var(--wb-ui-focus);outline-offset:1px}
`;

/** The line's look (tokens only), once per page: the hold line and the "반영했습니다" line (replace-in-place.ts) share it. */
export function ensureHoldStyle(doc: Document) {
  if (doc.getElementById("wb-ai-hold-style")) return;
  const style = doc.createElement("style"); style.id = "wb-ai-hold-style"; style.textContent = STYLE; doc.head.append(style);
}

const labelOf = (element: Element) =>
  (element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("data-tip") || element.textContent || "").trim().slice(0, 80);

/**
 * Draw the hold line and hold only what must wait. `stop`: the turn's own stop (this page's loop, or
 * the executor turn it observes). `lock` is the executor adapter's lock (execution-adapter.ts).
 */
export function installEditorHold(doc: Document, options: { shape: EditorHoldShape; stop(turnId: string | null): void | Promise<void>; state?: HoldState; tickMs?: number; graceMs?: number }) {
  const view = doc.defaultView!;
  const { shape } = options;
  const state = options.state ?? createHoldState(undefined, undefined, (event) => event.edit || toolEditsDocument(event.name));
  ensureHoldStyle(doc);
  const line = doc.createElement("div");
  line.className = "wb-ai-hold"; line.setAttribute("role", "status"); line.setAttribute("aria-live", "polite"); line.hidden = true;
  const lineText = doc.createElement("span");
  const lineWait = doc.createElement("button"); lineWait.type = "button"; lineWait.textContent = HOLD_WORDS.wait;
  const lineStop = doc.createElement("button"); lineStop.type = "button"; lineStop.textContent = HOLD_WORDS.stop;
  line.append(lineText, lineWait, lineStop);
  doc.body.append(line);
  let grace: number | undefined;
  const stop = () => {
    if (!state.view().working) return;
    state.stopRequested(); draw();
    void Promise.resolve(options.stop(state.turnId)).catch(() => {});
    view.clearTimeout(grace);
    grace = view.setTimeout(() => { if (state.view().working && state.view().stopping) { state.forceEnd(); draw(); } }, options.graceMs ?? STOP_GRACE_MS);
  };
  lineStop.onclick = stop;
  lineWait.onclick = () => { state.waitMore(); draw(); };
  let last = "";
  function draw() {
    const v = state.view();
    const key = JSON.stringify([v.held, v.line, v.silent, v.stopping]);
    if (key === last) return;
    last = key;
    line.hidden = !v.held;
    lineText.textContent = v.line;
    lineWait.hidden = !v.silent; lineStop.hidden = v.stopping;
    doc.documentElement.toggleAttribute("data-wb-ai-hold", v.held);
  }
  const off = onTurnActivity((event) => {
    state.report(event);
    if (event.kind === "end" || (event.kind === "observed" && !event.turnId)) view.clearTimeout(grace);
    draw();
  });
  const timer = view.setInterval(draw, options.tickMs ?? 1000);
  const woke = () => { if (doc.visibilityState !== "hidden") { state.woke(); draw(); } };
  doc.addEventListener("visibilitychange", woke);
  view.addEventListener("pageshow", woke);
  let flashTimer: number | undefined;
  const flash = () => {
    line.setAttribute("data-flash", "");
    view.clearTimeout(flashTimer);
    flashTimer = view.setTimeout(() => line.removeAttribute("data-flash"), 1200);
  };
  const held = () => state.view().held;
  const refuse = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); flash(); };
  const element = (target: EventTarget | null) => (target && (target as Node).nodeType === 1 ? target as Element : (target as Node | null)?.parentElement ?? null);
  const free = (target: Element | null) => Boolean(target?.closest(PANEL) || target?.closest(DIALOG) || target?.closest(".wb-ai-hold"));
  /** A plain text box beside the document (find, page number, zoom): typing there only looks. */
  const lookingBox = (target: Element | null) => Boolean(target?.matches(TEXT_INPUT) && target.closest(shape.surface) && !target.closest('[contenteditable="true"]'));
  const keydown = (event: KeyboardEvent) => {
    if (!held()) return;
    const target = element(event.target);
    if (free(target) || lookingBox(target)) return;
    if (keyOnlyLooks(event)) {
      if (shape.arrowsChange && /^Arrow/.test(event.key) && target?.closest(shape.arrowsChange)) refuse(event);
      return;
    }
    refuse(event);
  };
  const change = (event: Event) => {
    if (!held()) return;
    const target = element(event.target);
    if (free(target) || lookingBox(target)) return;
    if (target?.closest(shape.surface) || target?.closest(shape.chrome) || event.type === "drop") refuse(event);
  };
  const press = (event: Event) => {
    if (!held()) return;
    const target = element(event.target);
    if (free(target)) return;
    const control = target?.closest(CONTROL) ?? (target?.closest(shape.chrome) && target.matches(TEXT_INPUT) ? target : null);
    if (!control) return;
    // A ribbon's tab header only shows another row of controls.
    if (control.matches(TAB)) return;
    const label = labelOf(control);
    if (control.closest(shape.chrome) || control.closest(MENU)) {
      if (controlOnlyLooks(label)) return;
      refuse(event);
    } else if (CHANGES.test(label)) refuse(event);
  };
  const types: [string, EventListener][] = [["keydown", keydown as EventListener], ["beforeinput", change], ["paste", change], ["cut", change], ["drop", change], ["dragstart", change], ["compositionstart", change],
    ["pointerdown", press], ["mousedown", press], ["click", press]];
  for (const [type, listener] of types) view.addEventListener(type, listener, true);
  draw();
  return {
    state, draw, flash, held,
    lock(value: boolean) { state.lock(value); draw(); },
    dispose() {
      off(); view.clearInterval(timer); view.clearTimeout(grace); line.remove();
      doc.removeEventListener("visibilitychange", woke); view.removeEventListener("pageshow", woke);
      for (const [type, listener] of types) view.removeEventListener(type, listener, true);
      doc.documentElement.removeAttribute("data-wb-ai-hold");
    },
  };
}
export type EditorHold = ReturnType<typeof installEditorHold>;
