// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHoldState, installHwpHold, keyOnlyLooks, commandOnlyLooks, stepLabel, HOLD_WORDS, SILENT_AFTER_MS } from "./hwp-hold.ts";
import { reportTurnActivity } from "./turn-activity.ts";

const clock = () => { let t = 1_000_000; return { now: () => t, add: (ms: number) => { t += ms; } }; };
const edit = { kind: "tool" as const, id: "t1", name: "replace_text", status: "running" as const, edit: true };

describe("when the hold starts", () => {
  it("a turn that only answers holds nothing; it is still seen as working", () => {
    const c = clock(), s = createHoldState(c);
    s.report({ kind: "start" });
    s.report({ kind: "tool", id: "r", name: "read_document", status: "running", edit: false });
    s.report({ kind: "text", text: "답" });
    expect(s.view()).toMatchObject({ working: true, held: false, line: "", status: "문서 읽는 중" });
  });
  it("in this view's own loop the hold starts at the AI's first edit, not at sent", () => {
    const c = clock(), s = createHoldState(c);
    s.report({ kind: "start" });
    s.lock(true); expect(s.view().held).toBe(true); // the send's save/flush
    s.lock(false); expect(s.view().held).toBe(false);
    s.report(edit);
    expect(s.view()).toMatchObject({ held: true, edited: true, line: HOLD_WORDS.editing, status: "문서 고치는 중" });
  });
  it("an executor turn owns the saved file: typing is held from sent, with words that say so", () => {
    const s = createHoldState(clock());
    s.report({ kind: "start" }); s.lock(true); s.report({ kind: "remote", turnId: "x" });
    expect(s.view()).toMatchObject({ held: true, edited: false, line: HOLD_WORDS.owned });
  });
  it("an executor's edit seen only when done still counts (polled observation)", () => {
    const s = createHoldState(clock());
    s.report({ kind: "start" }); s.lock(true); s.report({ kind: "remote", turnId: "x" });
    s.report({ ...edit, status: "completed" });
    expect(s.view()).toMatchObject({ edited: true, line: HOLD_WORDS.editing, status: "문서 고치는 중" });
  });
  it("elapsed time is said once past 20 s", () => {
    const c = clock(), s = createHoldState(c);
    s.report({ kind: "start" });
    c.add(19_000); expect(s.view().status).toBe(HOLD_WORDS.working);
    c.add(2_000); expect(s.view().status).toBe(`${HOLD_WORDS.working} · 21초`);
  });
});

describe("every way the hold ends", () => {
  const held = () => { const c = clock(), s = createHoldState(c); s.report({ kind: "start" }); s.lock(true); s.report({ kind: "remote", turnId: "x" }); s.report(edit); return { c, s }; };
  it.each(["completed", "failed", "interrupted", "lost"] as const)("the turn ended: %s", (status) => {
    const { s } = held();
    s.report({ kind: "end", status, ...(status === "failed" ? { error: "엔진이 종료되었습니다." } : {}) });
    expect(s.view()).toMatchObject({ working: false, held: false, line: "" });
    if (status === "failed") expect(s.view().status).toBe("엔진이 종료되었습니다.");
    if (status === "completed") expect(s.view().status).toBe("");
  });
  it("the engine's error stays readable in the dock until the next turn", () => {
    const { s } = held();
    s.report({ kind: "end", status: "failed" });
    expect(s.view().status).toBe("문서 AI 작업을 마치지 못했습니다.");
    s.report({ kind: "start" }); expect(s.view().error).toBeNull();
  });
  it("no sign of life for the bound time: 응답이 없습니다, then 계속 기다리기 waits again", () => {
    const { c, s } = held();
    c.add(SILENT_AFTER_MS - 1); expect(s.view().silent).toBe(false);
    c.add(1); expect(s.view()).toMatchObject({ silent: true, line: HOLD_WORDS.silent, status: HOLD_WORDS.silent });
    s.waitMore(); expect(s.view().silent).toBe(false);
    c.add(SILENT_AFTER_MS); expect(s.view().silent).toBe(true);
    s.report({ kind: "text", text: "이제 답" }); expect(s.view().silent).toBe(false);
  });
  it("the tab slept and woke: the sleep is not counted as silence", () => {
    const { c, s } = held();
    c.add(SILENT_AFTER_MS * 3); s.woke();
    expect(s.view().silent).toBe(false);
  });
  it("a reopened view finds the executor's turn (held, with 중단), and lets go when it is gone", () => {
    const s = createHoldState(clock());
    s.report({ kind: "observed", turnId: "x" });
    expect(s.view()).toMatchObject({ working: true, held: true });
    expect(s.turnId).toBe("x");
    s.report({ kind: "observed", turnId: null });
    expect(s.view()).toMatchObject({ working: false, held: false });
  });
  it("중단 that gets no answer releases the hold (engine dead / gateway gone)", () => {
    const { s } = held();
    s.stopRequested(); expect(s.view().status).toBe(HOLD_WORDS.stopping);
    s.forceEnd(); expect(s.view().held).toBe(false);
  });
});

describe("what only looks", () => {
  it("keys", () => {
    for (const key of ["ArrowDown", "PageDown", "Home", "Shift", "Escape"]) expect(keyOnlyLooks({ key, ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    for (const key of ["c", "a", "f", "=", "-", "0"]) expect(keyOnlyLooks({ key, ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    for (const key of ["가", "a", "Enter", "Backspace", "Delete", "Tab", "Process"]) expect(keyOnlyLooks({ key, ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    for (const key of ["v", "x", "z", "y", "s", "b"]) expect(keyOnlyLooks({ key, ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    // v0.13.0: F9 and the Hanja key convert the word before the caret to Hanja (한자로 바꾸기): they change the document
    for (const key of ["F9", "HanjaMode", "Hanja"]) expect(keyOnlyLooks({ key, ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    for (const key of ["F5", "F7", "F11"]) expect(keyOnlyLooks({ key, ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
  });
  it("studio commands", () => {
    for (const c of ["view:zoom-in", "view:zoom-fit-page", "edit:copy", "edit:find", "file:print"]) expect(commandOnlyLooks(c)).toBe(true);
    // v0.13.0's File menu (the plugin's items): print, the print preview and a PDF copy only look, as Ctrl+P does; so does 문서 정보
    for (const c of ["ext:ieum-print", "ext:ieum-preview", "ext:ieum-export-pdf", "ieum:document-info"]) expect(commandOnlyLooks(c)).toBe(true);
    for (const c of ["edit:paste", "edit:undo", "file:save", "format:bold", "insert:table", "table:merge", "ext:ieum-save", "ext:ieum-save-as", "ieum:hanja", "ieum:table-auto-fill"]) expect(commandOnlyLooks(c)).toBe(false);
  });
  it("step words", () => {
    expect(stepLabel("use_skill")).toBe("스킬 읽는 중");
    expect(stepLabel("make_hangul_document")).toBe("한글 문서 만드는 중");
    expect(stepLabel("insert_paragraphs")).toBe("문서 고치는 중");
  });
});

describe("the page", () => {
  afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); });
  it("draws the hold line with 중단, refuses typing but not scrolling keys, flashes, and lets go at the end", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const hold = installHwpHold(document, { stop });
    const studio = document.createElement("iframe"); document.body.append(studio);
    const off = hold.guard(studio.contentWindow);
    const line = document.querySelector<HTMLElement>(".wb-hwp-hold")!;
    expect(line.hidden).toBe(true);
    reportTurnActivity({ kind: "start" }); reportTurnActivity(edit);
    expect(line.hidden).toBe(false);
    expect(line.textContent).toContain(HOLD_WORDS.editing);
    const body = studio.contentDocument!.body;
    const typed = new KeyboardEvent("keydown", { key: "가", bubbles: true, cancelable: true });
    body.dispatchEvent(typed); expect(typed.defaultPrevented).toBe(true);
    expect(line.hasAttribute("data-flash")).toBe(true);
    const scrolled = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
    body.dispatchEvent(scrolled); expect(scrolled.defaultPrevented).toBe(false);
    const zoom = studio.contentDocument!.createElement("button"); zoom.dataset.cmd = "view:zoom-in"; body.append(zoom);
    const save = studio.contentDocument!.createElement("button"); save.dataset.cmd = "file:save"; body.append(save);
    const z = new MouseEvent("click", { bubbles: true, cancelable: true }); zoom.dispatchEvent(z); expect(z.defaultPrevented).toBe(false);
    const sv = new MouseEvent("click", { bubbles: true, cancelable: true }); save.dispatchEvent(sv); expect(sv.defaultPrevented).toBe(true);
    // 중단: asks the turn to stop; with no answer the hold ends by itself after the grace.
    line.querySelector<HTMLButtonElement>("button:last-of-type")!.click();
    expect(stop).toHaveBeenCalledWith(null);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(line.hidden).toBe(true);
    const after = new KeyboardEvent("keydown", { key: "가", bubbles: true, cancelable: true });
    body.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
    off(); hold.dispose();
  });
  it("holds dragging an object like typing: a press on a selected picture/table or its handles, or on a table border, waits; a press elsewhere (caret, select) does not (office-leftovers 4c)", () => {
    const hold = installHwpHold(document, { stop: vi.fn() });
    const studio = document.createElement("iframe"); document.body.append(studio);
    const off = hold.guard(studio.contentWindow);
    const sdoc = studio.contentDocument!;
    sdoc.body.innerHTML = `<div id="scroll-container"><div id="scroll-content"><div class="page"></div><div class="table-object-layer"></div></div></div>`;
    const container = sdoc.getElementById("scroll-container")!, page = sdoc.querySelector<HTMLElement>(".page")!, layer = sdoc.querySelector<HTMLElement>(".table-object-layer")!;
    const press = (x: number, y: number) => { const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }); page.dispatchEvent(e); return e.defaultPrevented; };
    reportTurnActivity({ kind: "start" }); reportTurnActivity(edit);
    // Nothing selected, plain text cursor: a press places the caret / starts a selection — free.
    expect(press(100, 100)).toBe(false);
    // A picture is selected (the editor draws its outline and handles in .table-object-layer).
    const outline = sdoc.createElement("div"); layer.append(outline);
    vi.spyOn(outline, "getBoundingClientRect").mockReturnValue({ left: 200, top: 200, right: 300, bottom: 260, width: 100, height: 60, x: 200, y: 200, toJSON() {} } as DOMRect);
    expect(press(250, 230)).toBe(true);   // on the picture: would move it
    expect(press(305, 265)).toBe(true);   // on a corner handle just outside: would resize it
    expect(press(600, 600)).toBe(false);  // elsewhere: deselects / places the caret
    outline.remove();
    // Hovering a table border (the editor shows col-resize): the press would resize the column.
    container.style.cursor = "col-resize";
    expect(press(100, 100)).toBe(true);
    container.style.cursor = "";
    // At the end nothing is held.
    reportTurnActivity({ kind: "end", status: "completed" });
    container.style.cursor = "move";
    expect(press(100, 100)).toBe(false);
    off(); hold.dispose();
  });

  it("the dock's status line sits above its input and shows the engine's error", () => {
    document.body.innerHTML = `<div class="hwp-app"><div class="ai-dock"><div class="panel"><div class="ai-input-box"><textarea></textarea></div></div></div></div>`;
    const hold = installHwpHold(document, { stop: () => {} });
    reportTurnActivity({ kind: "start" });
    const status = document.querySelector<HTMLElement>(".ai-dock .wb-hwp-ai-status")!;
    expect(status.nextElementSibling?.className).toBe("ai-input-box");
    expect(status.hidden).toBe(false); expect(status.textContent).toContain(HOLD_WORDS.working);
    reportTurnActivity({ kind: "end", status: "failed", error: "모델 연결이 끊겼습니다." });
    expect(status.textContent).toContain("모델 연결이 끊겼습니다."); expect(status.dataset.tone).toBe("error");
    hold.dispose();
  });
});
