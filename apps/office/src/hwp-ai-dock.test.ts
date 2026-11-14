// @vitest-environment jsdom
// The Hangul editor's own AI dock as the document's one AI entry, 문서 AI, driven from the tab.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAiDockByDefault, installHwpAiDock, stepAsideForStudioDialogs } from "./hwp-ai-dock.ts";

/** The dock as Ieum's renderer draws it (AiDock.tsx, AiPanel.tsx), with its own open / close handlers. */
function editor(open = false) {
  document.body.innerHTML = `<div class="hwp-app"><div class="app-main">
    <div class="ai-dock${open ? "" : " collapsed"}">
      ${open ? "" : '<button type="button" class="ai-rail ai-entry" data-tip="AI 도우미 열기" aria-label="AI 도우미"></button>'}
      <aside class="copilot" aria-label="AI 도우미"><div class="ai-panel-resizer" role="separator" aria-label="AI 도우미"></div>
        <header class="ai-panel-header"><span class="ai-panel-title"><svg></svg>AI 도우미</span>
          <div class="ai-panel-header-actions"><button class="ai-header-btn ai-panel-collapse" aria-label="패널 접기"></button></div></header>
        <div class="ai-input-box"><textarea aria-label="AI에게 요청"></textarea></div></aside>
    </div><div class="hwp-editor-host"></div></div></div>`;
  const dock = document.querySelector<HTMLElement>(".ai-dock")!;
  const clicks = { rail: 0, collapse: 0 };
  // The renderer's React state: the rail opens (and goes away), the collapse button closes (the rail comes back).
  const wire = () => {
    dock.querySelector(".ai-rail")?.addEventListener("click", () => {
      clicks.rail++; dock.classList.remove("collapsed"); dock.querySelector(".ai-rail")?.remove();
    });
  };
  wire();
  dock.querySelector(".ai-panel-collapse")!.addEventListener("click", () => {
    clicks.collapse++; dock.classList.add("collapsed");
    dock.insertAdjacentHTML("afterbegin", '<button type="button" class="ai-rail ai-entry" data-tip="AI 도우미 열기" aria-label="AI 도우미"></button>');
    wire();
  });
  return { dock, clicks };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe("the Hangul editor's AI dock as 문서 AI", () => {
  it("is named 문서 AI wherever it names itself, also after the renderer redraws its title", async () => {
    const { dock } = editor(true);
    const ui = installHwpAiDock(document, { post: vi.fn() });
    expect(dock.querySelector(".ai-panel-title")!.textContent).toBe("문서 AI");
    expect(dock.querySelector("aside")!.getAttribute("aria-label")).toBe("문서 AI");
    expect(dock.querySelector(".ai-panel-resizer")!.getAttribute("aria-label")).toBe("문서 AI");
    // React writes its own label again on a redraw.
    dock.querySelector(".ai-panel-title")!.lastChild!.textContent = "AI 도우미";
    await tick();
    expect(dock.querySelector(".ai-panel-title")!.textContent).toBe("문서 AI");
    ui.dispose();
  });

  it("tells the tab whether it is open once its dock is drawn, and on every change", async () => {
    const { clicks } = editor(false);
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: false, shown: false, draft: "", person: false });
    ui.set(true);
    await tick();
    expect(clicks.rail).toBe(1);
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: true, shown: true, draft: "", person: false });
    // Asked for the state it is already in: nothing is pressed, but it answers (the tab knows it heard).
    post.mockClear();
    ui.set(true);
    expect(clicks.rail).toBe(1);
    expect(post).toHaveBeenCalledWith({ type: "office:ai-panel", ready: true, open: true, shown: true, draft: "", person: false });
    ui.set(false);
    await tick();
    expect(clicks.collapse).toBe(1);
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: false, shown: false, draft: "", person: false });
    // The renderer's own rail (now named 문서 AI) is the same dock.
    expect(document.querySelector(".ai-rail")!.getAttribute("aria-label")).toBe("문서 AI");
    ui.dispose();
  });

  // As in the real editor: the bridge installs before the renderer has drawn anything; the dock
  // appears (closed) only when the editor is ready (apps/hwp App.tsx phase === "ready").
  it("says nothing about an AI before its dock is drawn; when the dock appears it says ready, and then obeys", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ ready: true }));
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ open: false, ready: undefined }));
    // Asked before the dock exists: it answers that it is not ready, so the tab asks again later.
    ui.set(true);
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: false, open: false, shown: false, draft: "", person: false });
    post.mockClear();
    const { clicks } = editor(false);
    await tick();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: false, shown: false, draft: "", person: false });
    ui.set(true);
    await tick();
    expect(clicks.rail).toBe(1);
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: true, shown: true, draft: "", person: false });
    ui.dispose();
  });

  it("says when the person closed it with its own button, apart from the tab's requests", async () => {
    editor(true);
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    document.querySelector<HTMLElement>(".ai-panel-collapse")!.click();
    await tick();
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: false, shown: false, draft: "", person: true });
    ui.set(true);
    await tick();
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: true, shown: true, draft: "", person: false });
    ui.dispose();
  });

  it("hands what is typed in its input to the tab at once, so a switch of view right after the last key keeps it", () => {
    editor(true);
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    const input = document.querySelector<HTMLTextAreaElement>(".ai-input-box textarea")!;
    input.value = "이 표를 두 줄로";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // At once, not after a pause: nothing typed is left behind when the frame goes.
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: true, shown: true, draft: "이 표를 두 줄로", person: false });
    ui.dispose();
  });

  it("takes text typed in the column (글 보기) into its input when the tab opens it, through the input's own event, in place of what it held", async () => {
    editor(false);
    const input = document.querySelector<HTMLTextAreaElement>(".ai-input-box textarea")!;
    input.value = "예전 요청";
    // A controlled input (React): its state follows only the input event.
    const heard: string[] = [];
    input.addEventListener("input", () => heard.push(input.value));
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    ui.set(true, "표를 두 줄로 줄여 줘");
    await tick();
    expect(input.value).toBe("표를 두 줄로 줄여 줘");
    expect(heard).toEqual(["표를 두 줄로 줄여 줘"]);
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: true, shown: true, draft: "표를 두 줄로 줄여 줘", person: false });
    // Sent again (a retry): not added twice.
    ui.set(true, "표를 두 줄로 줄여 줘");
    expect(input.value).toBe("표를 두 줄로 줄여 줘");
    ui.dispose();
  });

  // Ruling A (round 3): the document's one draft is shown where the person is. The tab puts it into
  // the dock's input — open or closed (the panel stays mounted while collapsed) — REPLACING what the
  // input held (an old request kept by a hidden dock never comes back stacked over the new one).
  it("puts the document's draft into its input in place of what was there, open or closed, and always answers", async () => {
    const { clicks } = editor(false);
    const input = document.querySelector<HTMLTextAreaElement>(".ai-input-box textarea")!;
    const heard: string[] = [];
    input.addEventListener("input", () => heard.push(input.value));
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    input.value = "표를 두 줄로 줄여 줘";
    ui.put("표를 세 줄로 바꿔 줘");
    expect(input.value).toBe("표를 세 줄로 바꿔 줘");
    expect(heard).toEqual(["표를 세 줄로 바꿔 줘"]);
    expect(clicks.rail).toBe(0);
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: false, shown: false, draft: "표를 세 줄로 바꿔 줘", person: false });
    // A request sent elsewhere: the input is emptied, not left with it.
    ui.put("");
    expect(input.value).toBe("");
    // The same text again: nothing typed, but answered (the tab knows the dock has it).
    post.mockClear();
    ui.put("");
    expect(heard).toEqual(["표를 세 줄로 바꿔 줘", ""]);
    expect(post).toHaveBeenCalledWith({ type: "office:ai-panel", ready: true, open: false, shown: false, draft: "", person: false });
    ui.dispose();
  });

  it("keeps a draft put before its input exists and puts it there as soon as the input is drawn", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    ui.put("다른 요청 하나");
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: false, open: false, shown: false, draft: "", person: false });
    editor(true);
    await tick();
    expect(document.querySelector<HTMLTextAreaElement>(".ai-input-box textarea")!.value).toBe("다른 요청 하나");
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: true, shown: true, draft: "다른 요청 하나", person: false });
    ui.dispose();
  });

  it("starts closed unless the person left it open (the editor's own remembered state)", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    closeAiDockByDefault(storage);
    expect(store.get("hwpapp.showAi")).toBe("0");
    store.set("hwpapp.showAi", "1");
    closeAiDockByDefault(storage);
    expect(store.get("hwpapp.showAi")).toBe("1");
  });

  // Ruling C (round 3): at a narrow pane the open dock lies over the page; while one of the studio's
  // own dialogs is open it steps aside (hidden), and comes back when the dialog closes, untouched.
  it("steps aside while a studio dialog is open and comes back when it closes, its state and text untouched", async () => {
    const { dock } = editor(true);
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    const input = document.querySelector<HTMLTextAreaElement>(".ai-input-box textarea")!;
    ui.put("표를 두 줄로 줄여 줘");
    const frame = document.createElement("iframe");
    document.querySelector(".hwp-editor-host")!.append(frame);
    const studio = frame.contentDocument!;
    studio.body.innerHTML = '<div id="menu-bar"></div><div class="font-picker-menu" hidden></div>';
    const stop = stepAsideForStudioDialogs(document, studio);
    const aside = () => document.documentElement.hasAttribute("data-wb-studio-dialog");
    expect(aside()).toBe(false);
    post.mockClear();
    for (const html of ['<div class="modal-overlay"><div class="dialog-wrap">글자 모양</div></div>', '<div class="find-dialog">찾아 바꾸기</div>', '<div class="compare-dialog history-dialog">판 비교</div>']) {
      studio.body.insertAdjacentHTML("beforeend", html);
      await tick();
      expect(aside()).toBe(true);
      studio.body.lastElementChild!.remove();
      await tick();
      expect(aside()).toBe(false);
    }
    // Untouched: still open, its text kept, nothing reported to the tab (the button stays as it is).
    expect(dock.classList.contains("collapsed")).toBe(false);
    expect(input.value).toBe("표를 두 줄로 줄여 줘");
    expect(post).not.toHaveBeenCalled();
    // A hidden studio element is not an open dialog; the removal leaves nothing behind.
    studio.body.insertAdjacentHTML("beforeend", '<div class="modal-overlay" style="display: none"></div>');
    await tick();
    expect(aside()).toBe(false);
    studio.body.insertAdjacentHTML("beforeend", '<div class="modal-overlay"></div>');
    await tick();
    expect(aside()).toBe(true);
    stop();
    expect(aside()).toBe(false);
    ui.dispose();
  });

  it("hides the dock only where it lies over the page (the narrow layout), and only while the attribute says a studio dialog is open", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/apps/office/src/ui-adapters/hangul-studio.css`, "utf8").replace(/\s+/g, " ");
    const narrow = /@media \(max-width: 1039px\) \{(.*?)\} \}/.exec(css)?.[1] ?? "";
    expect(narrow).toMatch(/__WB_ROOT__\[data-wb-studio-dialog\]:not\(\[data-wb-ai-over\]\) \.hwp-app \.ai-dock:not\(\.collapsed\) \{[^}]*visibility: hidden/);
    // Nowhere outside the narrow layout (beside the page it covers nothing).
    expect(css.replace(narrow, "")).not.toContain("data-wb-studio-dialog");
  });
});

/**
 * The studio's own stylesheet for the dock, as the real page applies it (hangul-studio.css with its
 * root): `narrow` = the pane is at most 1039 px wide, so the narrow block applies (jsdom has no
 * viewport, so the block is taken out of its media query); wide = the block does not apply.
 */
async function layout(narrow: boolean) {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(`${process.cwd()}/apps/office/src/ui-adapters/hangul-studio.css`, "utf8");
  const start = css.indexOf("@media (max-width: 1039px) {");
  let depth = 0, end = css.indexOf("{", start);
  for (let at = end; at < css.length; at++) { if (css[at] === "{") depth++; else if (css[at] === "}" && --depth === 0) { end = at; break; } }
  const block = css.slice(css.indexOf("{", start) + 1, end);
  const rules = (narrow ? block : "").replace(/\/\*[\s\S]*?\*\//g, "").replaceAll("__WB_ROOT__", "html");
  let style = document.getElementById("zz-layout") as HTMLStyleElement | null;
  if (!style) { style = document.createElement("style"); style.id = "zz-layout"; document.head.append(style); }
  style.textContent = rules;
  window.dispatchEvent(new Event("resize"));
}
/** A studio frame inside the page, its dialogs appended to its body while open (as rhwp-studio does). */
function studioFrame() {
  const frame = document.createElement("iframe");
  document.querySelector(".hwp-editor-host")!.append(frame);
  const studio = frame.contentDocument!;
  studio.body.innerHTML = '<div id="menu-bar"></div>';
  return { frame, studio, open: (html = '<div class="find-dialog">찾기</div>') => { studio.body.insertAdjacentHTML("beforeend", html); return studio.body.lastElementChild!; } };
}
const visible = () => getComputedStyle(document.querySelector(".ai-dock")!).visibility !== "hidden";

// Ruling D (round 4, H7-R3-1): the frame says SHOWN apart from OPEN — the tab's button follows what
// is on screen — and a request to open (the person pressed 문서 AI) always gets a visible dock.
describe("문서 AI over the studio's dialogs (ruling D)", () => {
  afterEach(() => { document.getElementById("zz-layout")?.remove(); document.documentElement.removeAttribute("data-wb-studio-dialog"); document.documentElement.removeAttribute("data-wb-ai-over"); });

  it("narrow: while a dialog hides the open dock it reports open but not shown, its text untouched; shown again when the dialog closes — and the keys stay with the document (nobody asked for the AI)", async () => {
    editor(true);
    await layout(true);
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    ui.put("대화상자 뒤에 남는 글");
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, shown: true }));
    const { studio, open } = studioFrame();
    const stop = stepAsideForStudioDialogs(document, studio);
    const find = open();
    await tick();
    expect(visible()).toBe(false);
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: true, shown: false, draft: "대화상자 뒤에 남는 글", person: false });
    // The studio's Esc leaves focus on its body (nothing has it).
    find.remove();
    studio.body.focus();
    await tick(); await tick();
    expect(visible()).toBe(true);
    expect(post).toHaveBeenLastCalledWith({ type: "office:ai-panel", ready: true, open: true, shown: true, draft: "대화상자 뒤에 남는 글", person: false });
    // Re-review 4 (H7-R4-1): the dock came back by itself; what the teacher types next after Esc goes
    // on into the document, never into the AI's input.
    expect(document.activeElement).not.toBe(document.querySelector(".ai-input-box textarea"));
    stop(); ui.dispose();
  });

  it("narrow: the dock gets the focus back after the dialogs only when it had it before them, or the person brought it over them", async () => {
    editor(true);
    await layout(true);
    const ui = installHwpAiDock(document, { post: vi.fn() });
    const input = () => document.querySelector<HTMLTextAreaElement>(".ai-input-box textarea")!;
    const { studio, open } = studioFrame();
    const stop = stepAsideForStudioDialogs(document, studio);
    // The person was typing in the dock when the dialog opened: back to the dock afterwards.
    input().focus();
    let find = open();
    await tick();
    (document.activeElement as HTMLElement | null)?.blur();
    find.remove(); studio.body.focus();
    await tick(); await tick();
    expect(document.activeElement).toBe(input());
    // The person brought the dock over the dialog with a press: back to the dock afterwards.
    (document.activeElement as HTMLElement | null)?.blur();
    find = open();
    await tick();
    ui.set(true);
    await tick();
    (document.activeElement as HTMLElement | null)?.blur();
    find.remove(); studio.body.focus();
    await tick(); await tick();
    expect(document.activeElement).toBe(input());
    stop(); ui.dispose();
  });

  it("narrow: asked to open while hidden for a dialog (the person pressed 문서 AI), it comes over the dialog and stays until closed or the dialog closes; a new dialog hides it again", async () => {
    const { clicks } = editor(true);
    await layout(true);
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    const { studio, open } = studioFrame();
    const stop = stepAsideForStudioDialogs(document, studio);
    const find = open();
    await tick();
    expect(visible()).toBe(false);
    ui.set(true);
    await tick();
    expect(visible()).toBe(true);
    expect(clicks.collapse).toBe(0);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, shown: true }));
    // Typing in the dock over the dialog: it stays.
    const input = document.querySelector<HTMLTextAreaElement>(".ai-input-box textarea")!;
    input.value = "찾기 위에서 묻는 말"; input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(visible()).toBe(true);
    // Another dialog of the studio opens: the dock steps aside for it (reported not shown).
    const shape = open('<div class="modal-overlay"><div class="dialog-wrap">글자 모양</div></div>');
    await tick();
    expect(visible()).toBe(false);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, shown: false }));
    // Asked again: over both.
    ui.set(true);
    await tick();
    expect(visible()).toBe(true);
    shape.remove(); find.remove();
    await tick();
    expect(visible()).toBe(true);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, shown: true, draft: "찾기 위에서 묻는 말" }));
    // The next dialog hides it again (being brought over ended with the dialog).
    open();
    await tick();
    expect(visible()).toBe(false);
    stop(); ui.dispose();
  });

  it("narrow: closed while a dialog is open, asked to open → opens visible over the dialog; closed by the person, asked again → visible again", async () => {
    const { clicks } = editor(false);
    await layout(true);
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    const { studio, open } = studioFrame();
    const stop = stepAsideForStudioDialogs(document, studio);
    open();
    await tick();
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: false, shown: false }));
    ui.set(true);
    await tick();
    expect(clicks.rail).toBe(1);
    expect(visible()).toBe(true);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, shown: true }));
    document.querySelector<HTMLElement>(".ai-panel-collapse")!.click();
    await tick();
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: false, shown: false, person: true }));
    ui.set(true);
    await tick();
    expect(visible()).toBe(true);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, shown: true }));
    stop(); ui.dispose();
  });

  it("wide: a dialog hides nothing (the dock is beside the page), reported shown; the pane narrowed with the dialog open → not shown", async () => {
    editor(true);
    await layout(false);
    const post = vi.fn();
    const ui = installHwpAiDock(document, { post });
    const { studio, open } = studioFrame();
    const stop = stepAsideForStudioDialogs(document, studio);
    open();
    await tick();
    expect(visible()).toBe(true);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, shown: true }));
    await layout(true);
    await tick();
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, shown: false }));
    await layout(false);
    await tick();
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, shown: true }));
    stop(); ui.dispose();
  });
});
