// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_HOLD_SHAPES, installEditorHold, toolEditsDocument, controlOnlyLooks } from "./editor-hold.ts";
import { HOLD_WORDS, createHoldState } from "./hwp-hold.ts";
import { reportTurnActivity } from "./turn-activity.ts";

const key = (target: EventTarget, init: KeyboardEventInit) => { const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }); target.dispatchEvent(event); return event.defaultPrevented; };
const click = (target: EventTarget) => { const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true }); target.dispatchEvent(event); return event.defaultPrevented; };
const page = () => {
  document.body.innerHTML = `
    <aside class="ai-dock"><textarea class="ask"></textarea><button class="send">보내기</button></aside>
    <header class="ribbon"><button class="ribbon-tab">삽입</button><button class="bold" title="굵게">B</button>
      <button class="zoom" title="확대">+</button><button class="setup" title="페이지 설정">P</button><input class="size" value="11"></header>
    <div class="app-content"><input class="find" type="search"><div class="page" contenteditable="true"><p>본문</p></div>
      <button class="nav">1장 개요</button><button class="replace">모두 바꾸기</button></div>`;
  return {
    ask: document.querySelector(".ask")!, page: document.querySelector(".page")!, find: document.querySelector(".find")!,
    tab: document.querySelector(".ribbon-tab")!, bold: document.querySelector(".bold")!, zoom: document.querySelector(".zoom")!,
    setup: document.querySelector(".setup")!, size: document.querySelector(".size")!, nav: document.querySelector(".nav")!, replace: document.querySelector(".replace")!,
  };
};
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("which tools change the document (non-Hangul editors)", () => {
  it.each(["replace_blocks", "insert_content", "apply_ops", "write_document", "edit_text", "propose_operations", "generate_deck", "execute_slide_script", "set_page_setup"])("%s changes", (name) => {
    expect(toolEditsDocument(name)).toBe(true);
  });
  it.each(["read_blocks", "get_document_context", "read_slide", "read_range", "find_cells", "web_search", "image_search", "list_styles", "load_guide", "plan_deck", "trace_precedents", "goto_page", "search_text", "ask_clarification", "use_skill", "read_skill_file", "analyze_media", "check_pages"])("%s only reads", (name) => {
    expect(toolEditsDocument(name)).toBe(false);
  });
});

describe("controls that only look", () => {
  it("names: view, zoom, find, copy, print, export; a change word wins", () => {
    for (const label of ["확대", "축소", "보기", "찾기", "복사", "인쇄", "PDF로 내보내기", "다음 슬라이드", "전체 화면"]) expect(controlOnlyLooks(label)).toBe(true);
    for (const label of ["굵게", "페이지 설정", "모두 바꾸기", "삽입", "스타일 적용", "저장", "붙여넣기", "실행 취소", "찾아 바꾸기"]) expect(controlOnlyLooks(label)).toBe(false);
  });
});

describe("the hold in an editor page (Word shape)", () => {
  it("nothing is held without a turn", () => {
    const p = page(), hold = installEditorHold(document, { shape: EDITOR_HOLD_SHAPES.word, stop: () => {} });
    expect(key(p.page, { key: "가" })).toBe(false);
    expect(click(p.bold)).toBe(false);
    hold.dispose();
  });
  it("an executor turn: looking stays free, typing and changing commands wait, the line says so and flashes", () => {
    vi.useFakeTimers();
    const p = page(), stop = vi.fn(), hold = installEditorHold(document, { shape: EDITOR_HOLD_SHAPES.word, stop, graceMs: 8_000 });
    reportTurnActivity({ kind: "start" }); hold.lock(true); reportTurnActivity({ kind: "remote", turnId: "t" });
    const line = document.querySelector<HTMLElement>(".wb-ai-hold")!;
    expect(line.hidden).toBe(false);
    expect(line.textContent).toContain(HOLD_WORDS.owned);
    expect(line.querySelector<HTMLElement>("button:last-of-type")?.textContent).toBe(HOLD_WORDS.stop);
    expect(line.querySelector<HTMLElement>("button:first-of-type")?.hidden).toBe(true);
    // Nothing is inert: the page and the ribbon can still be scrolled, selected and pointed at.
    expect(document.querySelector<HTMLElement>(".app-content")!.inert).toBeFalsy();
    expect(document.querySelector<HTMLElement>(".ribbon")!.inert).toBeFalsy();
    // Looking.
    for (const look of ["ArrowDown", "PageDown", "Home"]) expect(key(p.page, { key: look })).toBe(false);
    expect(key(p.page, { key: "c", ctrlKey: true })).toBe(false);
    expect(key(p.page, { key: "f", ctrlKey: true })).toBe(false);
    expect(click(p.zoom)).toBe(false);
    expect(click(p.tab)).toBe(false);
    expect(click(p.nav)).toBe(false);
    expect(key(p.find, { key: "가" })).toBe(false); // the find box is not the document
    // The 문서 AI panel is never held.
    expect(key(p.ask, { key: "가" })).toBe(false);
    // Changing: refused, and the line is noticed.
    expect(key(p.page, { key: "가" })).toBe(true);
    expect(line.hasAttribute("data-flash")).toBe(true);
    expect(key(p.page, { key: "Backspace" })).toBe(true);
    expect(key(p.page, { key: "s", ctrlKey: true })).toBe(true);
    expect(key(document.body, { key: "z", ctrlKey: true })).toBe(true);
    expect(click(p.bold)).toBe(true);
    expect(click(p.setup)).toBe(true);
    expect(click(p.replace)).toBe(true);
    expect(key(p.size, { key: "2" })).toBe(true);
    for (const type of ["beforeinput", "paste", "cut", "drop", "dragstart"]) {
      const event = new Event(type, { bubbles: true, cancelable: true }); p.page.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    }
    // 중단: asks the turn to stop; an answer that never comes ends the hold after the grace.
    line.querySelector<HTMLButtonElement>("button:last-of-type")!.click();
    expect(stop).toHaveBeenCalledWith("t");
    vi.advanceTimersByTime(9_000);
    expect(line.hidden).toBe(true);
    expect(key(p.page, { key: "가" })).toBe(false);
    hold.dispose();
  });
  it.each(["completed", "failed", "interrupted", "lost"] as const)("the hold ends when the turn ends: %s", (status) => {
    const p = page(), hold = installEditorHold(document, { shape: EDITOR_HOLD_SHAPES.word, stop: () => {} });
    reportTurnActivity({ kind: "start" }); hold.lock(true); reportTurnActivity({ kind: "remote", turnId: "t" });
    expect(key(p.page, { key: "가" })).toBe(true);
    reportTurnActivity({ kind: "end", status }); hold.lock(false);
    expect(key(p.page, { key: "가" })).toBe(false);
    expect(document.querySelector<HTMLElement>(".wb-ai-hold")!.hidden).toBe(true);
    hold.dispose();
  });
  it("a reopened view that finds an executor turn holds with 중단, and lets go when the turn is gone", () => {
    const p = page(), stop = vi.fn(), hold = installEditorHold(document, { shape: EDITOR_HOLD_SHAPES.word, stop });
    hold.lock(true); reportTurnActivity({ kind: "observed", turnId: "x" });
    expect(key(p.page, { key: "가" })).toBe(true);
    document.querySelector<HTMLButtonElement>(".wb-ai-hold button:last-of-type")!.click();
    expect(stop).toHaveBeenCalledWith("x");
    hold.lock(false); reportTurnActivity({ kind: "observed", turnId: null });
    expect(key(p.page, { key: "가" })).toBe(false);
    hold.dispose();
  });
  it("this view's own (live) turn holds from the AI's first edit, whatever the tool's name says", () => {
    const p = page(), hold = installEditorHold(document, { shape: EDITOR_HOLD_SHAPES.word, stop: () => {} });
    reportTurnActivity({ kind: "start" }); hold.lock(true); hold.lock(false);
    reportTurnActivity({ kind: "tool", id: "1", name: "read_blocks", status: "running", edit: false });
    expect(key(p.page, { key: "가" })).toBe(false);
    reportTurnActivity({ kind: "tool", id: "2", name: "replace_blocks", status: "running", edit: false });
    expect(key(p.page, { key: "가" })).toBe(true);
    expect(document.querySelector(".wb-ai-hold")!.textContent).toContain(HOLD_WORDS.editing);
    reportTurnActivity({ kind: "end", status: "completed" });
    expect(key(p.page, { key: "가" })).toBe(false);
    hold.dispose();
  });
  it("no sign of life: 응답이 없습니다 with 중단 and 계속 기다리기", () => {
    let t = 0; const state = createHoldState({ now: () => t }, 90_000);
    page(); const hold = installEditorHold(document, { shape: EDITOR_HOLD_SHAPES.word, stop: () => {}, state });
    reportTurnActivity({ kind: "start" }); hold.lock(true); reportTurnActivity({ kind: "remote", turnId: "t" });
    t += 91_000; hold.draw();
    const line = document.querySelector<HTMLElement>(".wb-ai-hold")!;
    expect(line.textContent).toContain(HOLD_WORDS.silent);
    const wait = [...line.querySelectorAll("button")].find((button) => button.textContent === HOLD_WORDS.wait)!;
    expect(wait.hidden).toBe(false);
    wait.click();
    expect(line.textContent).not.toContain(HOLD_WORDS.silent);
    reportTurnActivity({ kind: "end", status: "completed" });
    hold.dispose();
  });
  it("a tab that slept and woke is not 'silent' for the time it slept", () => {
    let t = 0; const state = createHoldState({ now: () => t }, 90_000);
    page(); const hold = installEditorHold(document, { shape: EDITOR_HOLD_SHAPES.word, stop: () => {}, state });
    reportTurnActivity({ kind: "start" }); hold.lock(true); reportTurnActivity({ kind: "remote", turnId: "t" });
    t += 300_000; document.dispatchEvent(new Event("visibilitychange"));
    expect(document.querySelector(".wb-ai-hold")!.textContent).not.toContain(HOLD_WORDS.silent);
    reportTurnActivity({ kind: "end", status: "completed" });
    hold.dispose();
  });
  it("menus opened outside the ribbon (portals) follow the same naming rule", () => {
    const p = page(), hold = installEditorHold(document, { shape: EDITOR_HOLD_SHAPES.word, stop: () => {} });
    const menu = document.createElement("div"); menu.setAttribute("role", "menu");
    menu.innerHTML = `<div role="menuitem">저장</div><div role="menuitem">인쇄</div>`; document.body.append(menu);
    reportTurnActivity({ kind: "start" }); hold.lock(true); reportTurnActivity({ kind: "remote", turnId: "t" });
    expect(click(menu.children[0]!)).toBe(true);
    expect(click(menu.children[1]!)).toBe(false);
    void p; reportTurnActivity({ kind: "end", status: "completed" }); hold.dispose();
  });
});

describe("every editor has a shape", () => {
  it.each(["word", "slides", "sheets", "pdf", "markdown", "html"] as const)("%s", (format) => {
    const shape = EDITOR_HOLD_SHAPES[format];
    expect(shape.surface).toBeTruthy(); expect(shape.chrome).toBeTruthy();
  });
});

describe("the executor adapters hand their lock to the hold (no inert page)", () => {
  afterEach(() => { delete (globalThis as { workbenchEditorHold?: unknown }).workbenchEditorHold; });
  it("PowerPoint / HTML and Excel / PDF locks", async () => {
    const { lockPresentationSurface } = await import("./execution-presentations.ts");
    const { createOriginalBookLock } = await import("./execution-book-state.ts");
    const p = page(), hold = installEditorHold(document, { shape: EDITOR_HOLD_SHAPES.slides, stop: () => {} });
    Object.assign(globalThis, { workbenchEditorHold: hold });
    reportTurnActivity({ kind: "start" });
    lockPresentationSurface(true); reportTurnActivity({ kind: "remote", turnId: "t" });
    expect(document.querySelector<HTMLElement>(".app-content")!.inert).toBeFalsy();
    expect(key(p.page, { key: "ArrowDown" })).toBe(false);
    expect(key(p.page, { key: "가" })).toBe(true);
    reportTurnActivity({ kind: "end", status: "completed" }); lockPresentationSurface(false);
    expect(key(p.page, { key: "가" })).toBe(false);
    const book = createOriginalBookLock(".app-content, .ribbon");
    reportTurnActivity({ kind: "start" }); book(true); reportTurnActivity({ kind: "remote", turnId: "u" });
    expect(document.querySelector<HTMLElement>(".app-content")!.inert).toBeFalsy();
    expect(key(p.page, { key: "가" })).toBe(true);
    reportTurnActivity({ kind: "end", status: "completed" }); book(false);
    expect(key(p.page, { key: "가" })).toBe(false);
    hold.dispose();
  });
  it("Word and Markdown patches lock through the hold, inert only where no hold exists", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { patchOfficeExecution } = await import("../execution-patch.ts");
    const root = resolve("vendor/ieumoffice");
    for (const app of ["docs", "markdown"]) {
      const id = `${root}/apps/${app}/src/renderer/ai/AiPanel.tsx`;
      const code = patchOfficeExecution(readFileSync(id, "utf8"), id, root, "/workbench/execution-adapter.ts");
      expect(code).toContain("workbenchEditorHold");
      expect(code).toMatch(/if \(hold\) hold\.lock\(locked\); else/);
    }
  });
});
