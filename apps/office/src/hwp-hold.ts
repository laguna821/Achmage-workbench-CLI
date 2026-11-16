/**
 * The Hangul editor while its document AI works (brief ux/briefs/hwp-ai-brief.md, points 1 and 2).
 *
 * 0.5.1 made the whole editor `inert` (studio, menus, top bar) from "sent" to the end of the turn,
 * and drew nothing but the dock's "생각 중". Now:
 * - LOOKING is never held: scroll, zoom, paging, selection, copy, find, view menus, the dock.
 * - TYPING and the commands that change or save the document are held only while they must be:
 *   from the AI's first edit to the end of the turn (a turn that only answers holds nothing), or —
 *   when the turn runs in the independent executor, which owns the saved file for the turn
 *   (the gateway refuses this view's save, and an edit made here could not be merged into its
 *   result) — from "sent".
 * - While held, one quiet line says so on the editor, with 중단; a held key or click flashes it.
 * - Something is always drawn: a status line in the dock from "sent" (its step words, the elapsed
 *   time past 20 s, the engine's error as text).
 * - The hold ALWAYS ends: the turn finished / failed / was stopped; the engine died (a failed
 *   end); the gateway stopped confirming it (execution-client.ts releases it); no sign of life
 *   for a bound time (→ "응답이 없습니다" · 중단 / 계속 기다리기); the tab woke; 중단 that gets no
 *   answer releases the hold here after a short wait.
 */
import { HWP_EDIT_TOOLS, onTurnActivity, type TurnActivity } from "./turn-activity.ts";

export const HOLD_WORDS = {
  editing: "문서 AI가 문서를 고치는 중입니다",
  owned: "문서 AI가 작업하는 동안 문서 입력을 잠시 멈춥니다",
  silent: "응답이 없습니다",
  stop: "중단",
  wait: "계속 기다리기",
  working: "문서 AI 작업 중",
  stopping: "중단하는 중",
} as const;

/** Step words of the dock's status line (the dock's own "생각 중" / "작업 중" where they fit). */
export function stepLabel(name: string): string {
  if (name === "use_skill") return "스킬 읽는 중";
  if (name === "read_skill_file") return "스킬 파일 읽는 중";
  if (name === "make_hangul_document") return "한글 문서 만드는 중";
  if (HWP_EDIT_TOOLS.has(name)) return "문서 고치는 중";
  if (/^(read_|find_|list_)/.test(name) && name !== "read_url") return "문서 읽는 중";
  if (/search|read_url|fetch|knowledge|drive/.test(name)) return "자료 찾는 중";
  return "작업 중";
}

export type HoldView = {
  /** a turn is running (sent here, or observed in the executor) */
  working: boolean;
  /** typing and document-changing commands are held */
  held: boolean;
  /** the AI has started an edit in this turn */
  edited: boolean;
  /** no sign of life for the bound time */
  silent: boolean;
  stopping: boolean;
  /** the dock's status line ('' when nothing to say) */
  status: string;
  /** the editor's hold line ('' when not held) */
  line: string;
  /** the last end's error, kept until the next turn */
  error: string | null;
  elapsedSeconds: number;
};

type Clock = { now(): number };
export const SILENT_AFTER_MS = 90_000;
export const ELAPSED_AFTER_MS = 20_000;
export const STOP_GRACE_MS = 8_000;

/** The pure state: what is held and what is said, from the turn's reports. */
export function createHoldState(clock: Clock = { now: () => Date.now() }, silentAfter = SILENT_AFTER_MS) {
  let working = false, locked = false, edited = false, stopping = false, waitedUntil = 0;
  let startedAt = 0, lastLife = 0, step = "", error: string | null = null, observed: string | null = null;
  const begin = () => {
    if (!working) { working = true; startedAt = lastLife = clock.now(); edited = false; stopping = false; step = ""; error = null; }
  };
  const finish = (reason?: string) => {
    working = false; locked = false; edited = false; stopping = false; observed = null; step = "";
    error = reason ?? null;
  };
  return {
    report(event: TurnActivity) {
      if (event.kind === "start") { finish(); begin(); return; }
      if (event.kind === "end") {
        const reason = event.status === "completed" ? undefined : event.error ?? (event.status === "interrupted" ? undefined : "문서 AI 작업을 마치지 못했습니다.");
        finish(reason); return;
      }
      if (event.kind === "observed") {
        if (event.turnId) { observed = event.turnId; begin(); locked = true; }
        else if (observed) finish();
        return;
      }
      if (!working) return;
      lastLife = clock.now();
      if (event.kind === "remote") { observed = event.turnId; locked = true; }
      // An observed executor turn may show a tool only once it is done (polled): it still names the
      // step, and an edit seen done still means the AI has started changing the document.
      if (event.kind === "tool") { step = stepLabel(event.name); if (event.edit) edited = true; }
    },
    /** the adapter's lock (execution-adapter.ts): the executor owns the document, or a send is being prepared */
    lock(value: boolean) { locked = value; if (value) begin(); },
    stopRequested() { if (working) stopping = true; },
    waitMore() { lastLife = waitedUntil = clock.now(); },
    /** the tab woke: the next observation decides; no "응답이 없습니다" for the time it slept */
    woke() { if (working) lastLife = clock.now(); },
    /** 중단 got no end within the grace: release here (the gateway's run is ended by its own lease) */
    forceEnd() { if (working) finish(); },
    get turnId() { return observed; },
    view(): HoldView {
      const now = clock.now();
      const silent = working && now - lastLife >= silentAfter && now - waitedUntil >= silentAfter;
      const held = working && (locked || edited);
      const elapsed = working ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
      const time = elapsed * 1000 >= ELAPSED_AFTER_MS ? ` · ${elapsed}초` : "";
      const status = !working ? (error ?? "") : stopping ? HOLD_WORDS.stopping : silent ? HOLD_WORDS.silent : `${step || HOLD_WORDS.working}${time}`;
      const line = !held ? "" : silent ? HOLD_WORDS.silent : edited ? HOLD_WORDS.editing : HOLD_WORDS.owned;
      return { working, held, edited, silent, stopping, status, line, error: working ? null : error, elapsedSeconds: elapsed };
    },
  };
}
export type HoldState = ReturnType<typeof createHoldState>;

/** Keys that only look (move the caret/view, select, copy, find, zoom) — never held. */
export function keyOnlyLooks(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  const key = event.key;
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "ContextMenu"].includes(key)) return true;
  if (/^F\d+$/.test(key) && key !== "F2") return true;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && ["c", "a", "f", "g", "=", "+", "-", "0", "p"].includes(key.toLowerCase())) return true;
  return false;
}
/** Studio commands (data-cmd) that only read or change the view — never held. */
export function commandOnlyLooks(command: string): boolean {
  if (command.startsWith("view:")) return true;
  return ["edit:copy", "edit:select-all", "edit:find", "edit:find-again", "edit:goto", "edit:compare-documents", "edit:document-history",
    "file:print", "file:print-to-pdf", "file:about"].includes(command);
}

const DIALOG = ".modal-overlay, .dialog-wrap, .find-dialog, .compare-dialog, [role=\"dialog\"]";
const STYLE = `
.wb-hwp-hold{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:8px;
  padding:6px 8px 6px 14px;border:1px solid var(--wb-ui-line-strong);border-radius:var(--wb-ui-radius-card);background:var(--wb-ui-bg);
  color:var(--wb-ui-text);font:var(--wb-ui-text-sm) var(--wb-ui-font);box-shadow:0 2px 0 var(--wb-ui-line)}
.wb-hwp-hold[hidden]{display:none}
.wb-hwp-hold[data-flash]{outline:2px solid var(--wb-ui-focus);outline-offset:1px}
.wb-hwp-hold button,.wb-hwp-ai-status button{font:inherit;color:var(--wb-ui-text);background:var(--wb-ui-group);border:1px solid var(--wb-ui-line);
  border-radius:var(--wb-ui-radius-key);padding:2px 10px;cursor:pointer}
.wb-hwp-hold button:hover,.wb-hwp-ai-status button:hover{background:var(--wb-ui-hover)}
.wb-hwp-hold button:focus-visible,.wb-hwp-ai-status button:focus-visible{outline:2px solid var(--wb-ui-focus);outline-offset:1px}
.wb-hwp-ai-status{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--wb-ui-line);
  color:var(--wb-ui-muted);font:var(--wb-ui-text-sm) var(--wb-ui-font);background:var(--wb-ui-group)}
.wb-hwp-ai-status[hidden]{display:none}
.wb-hwp-ai-status[data-tone="error"]{color:var(--wb-ui-danger)}
.wb-hwp-ai-status span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

/**
 * Draw the hold line and the dock's status line, and hold only what must wait. `stop`: the turn's
 * own stop (the dock's loop, or the executor's). Returns `guard(studioWindow)` for the studio frame
 * (installed again on its reload) and `dispose`.
 */
export function installHwpHold(doc: Document, options: { stop(turnId: string | null): void | Promise<void>; state?: HoldState; tickMs?: number; graceMs?: number }) {
  const view = doc.defaultView!;
  const state = options.state ?? createHoldState();
  const style = doc.createElement("style"); style.textContent = STYLE; doc.head.append(style);
  const line = doc.createElement("div");
  line.className = "wb-hwp-hold"; line.setAttribute("role", "status"); line.setAttribute("aria-live", "polite"); line.hidden = true;
  const lineText = doc.createElement("span");
  const lineStop = doc.createElement("button"); lineStop.type = "button"; lineStop.textContent = HOLD_WORDS.stop;
  const lineWait = doc.createElement("button"); lineWait.type = "button"; lineWait.textContent = HOLD_WORDS.wait;
  line.append(lineText, lineWait, lineStop);
  doc.body.append(line);
  const status = doc.createElement("div");
  status.className = "wb-hwp-ai-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.hidden = true;
  const statusText = doc.createElement("span");
  const statusStop = doc.createElement("button"); statusStop.type = "button"; statusStop.textContent = HOLD_WORDS.stop;
  const statusWait = doc.createElement("button"); statusWait.type = "button"; statusWait.textContent = HOLD_WORDS.wait;
  status.append(statusText, statusWait, statusStop);
  let grace: number | undefined;
  const stop = () => {
    if (!state.view().working) return;
    state.stopRequested(); draw();
    void Promise.resolve(options.stop(state.turnId)).catch(() => {});
    // An engine that died or a gateway that is gone may never answer the stop: the hold ends here.
    view.clearTimeout(grace);
    grace = view.setTimeout(() => { if (state.view().working && state.view().stopping) { state.forceEnd(); draw(); } }, options.graceMs ?? STOP_GRACE_MS);
  };
  const waitMore = () => { state.waitMore(); draw(); };
  lineStop.onclick = stop; statusStop.onclick = stop; lineWait.onclick = waitMore; statusWait.onclick = waitMore;
  /** The dock's panel is drawn by its React tree: the status line goes in right above its input. */
  const placeStatus = () => {
    const box = doc.querySelector(".hwp-app .ai-dock .ai-input-box");
    const host = box?.parentElement;
    if (host && status.parentElement !== host) host.insertBefore(status, box);
  };
  let last = "";
  function draw() {
    const v = state.view();
    const key = JSON.stringify(v);
    placeStatus();
    if (key === last) return;
    last = key;
    line.hidden = !v.held;
    lineText.textContent = v.line;
    lineWait.hidden = !v.silent; lineStop.hidden = v.stopping;
    status.hidden = !v.status;
    statusText.textContent = v.status;
    status.dataset.tone = !v.working && v.error ? "error" : "";
    statusStop.hidden = !v.working || v.stopping; statusWait.hidden = !v.silent;
    doc.documentElement.toggleAttribute("data-wb-ai-hold", v.held);
  }
  const off = onTurnActivity((event) => {
    state.report(event);
    if (event.kind === "end" || (event.kind === "observed" && !event.turnId)) view.clearTimeout(grace);
    draw();
  });
  const timer = view.setInterval(draw, options.tickMs ?? 1000);
  const observer = new view.MutationObserver(() => placeStatus());
  observer.observe(doc.body, { childList: true, subtree: true });
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
  /** One held action: refused quietly, the line says why. */
  const refuse = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); flash(); };
  const inDialog = (target: EventTarget | null) => Boolean((target as Element | null)?.closest?.(DIALOG));
  const guard = (win: Window | null | undefined) => {
    if (!win) return () => {};
    const keydown = (event: KeyboardEvent) => { if (held() && !inDialog(event.target) && !keyOnlyLooks(event)) refuse(event); };
    const change = (event: Event) => { if (held() && !inDialog(event.target)) refuse(event); };
    const click = (event: Event) => {
      if (!held()) return;
      const command = (event.target as Element | null)?.closest?.("[data-cmd]")?.getAttribute("data-cmd");
      if (command && !commandOnlyLooks(command)) refuse(event);
    };
    const types: [string, EventListener][] = [["keydown", keydown as EventListener], ["beforeinput", change], ["paste", change], ["cut", change], ["drop", change], ["compositionstart", change], ["click", click], ["mousedown", click]];
    for (const [type, listener] of types) win.addEventListener(type, listener, true);
    return () => { for (const [type, listener] of types) win.removeEventListener(type, listener, true); };
  };
  // The outer page: the memo panel changes the document; the dock and the top bar never wait.
  const memo = (event: Event) => { if (held() && (event.target as Element | null)?.closest?.(".memo-panel")) refuse(event); };
  for (const type of ["beforeinput", "paste", "drop", "click"]) doc.addEventListener(type, memo, true);
  draw();
  return {
    state, draw, guard, flash, held,
    /** the adapter's lock (the executor owns the document / a send is prepared) */
    lock(value: boolean) { state.lock(value); draw(); },
    dispose() {
      off(); view.clearInterval(timer); observer.disconnect(); line.remove(); status.remove(); style.remove();
      doc.removeEventListener("visibilitychange", woke); view.removeEventListener("pageshow", woke);
      for (const type of ["beforeinput", "paste", "drop", "click"]) doc.removeEventListener(type, memo, true);
    },
  };
}
