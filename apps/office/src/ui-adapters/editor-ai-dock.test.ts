// @vitest-environment jsdom
// The editors' own AI panel (Word, PowerPoint, Excel, PDF, Markdown, HTML) as the document's one 문서 AI, driven from the tab.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installEditorAiDock, type EditorAiReport } from "./editor-ai-dock.ts";

/** Word / PowerPoint / PDF / Markdown / HTML: `.ai-dock` with a rail key while closed. */
function dockEditor(open = false, off = false) {
  document.body.innerHTML = `<div class="app-main"><div class="doc-page">본문</div>
    <div class="ai-dock${open ? "" : " collapsed"}${off ? " ai-dock-off" : ""}">
      ${open || off ? "" : '<button type="button" class="ai-rail" aria-label="문서 AI 열기"></button>'}
      <aside class="copilot"><header class="ai-panel-header"><span class="ai-panel-title">문서 AI</span>
        <button class="ai-header-btn ai-panel-collapse" aria-label="패널 접기"></button></header>
        <div class="ai-input-box"><textarea></textarea></div></aside></div></div>`;
  const dock = document.querySelector<HTMLElement>(".ai-dock")!;
  const clicks = { rail: 0, collapse: 0 };
  const wire = () => dock.querySelector(".ai-rail")?.addEventListener("click", () => { clicks.rail++; dock.classList.remove("collapsed"); dock.querySelector(".ai-rail")?.remove(); });
  wire();
  dock.querySelector(".ai-panel-collapse")!.addEventListener("click", () => {
    clicks.collapse++; dock.classList.add("collapsed");
    dock.insertAdjacentHTML("afterbegin", '<button type="button" class="ai-rail" aria-label="문서 AI 열기"></button>'); wire();
  });
  return { dock, clicks };
}
/** Excel: `aside.copilot.collapsed` with its expand key while closed, the open panel otherwise. */
function sheetsEditor() {
  document.body.innerHTML = '<div class="sheet-body"><div class="grid"></div><aside class="copilot collapsed"><button class="expand-copilot" aria-label="문서 AI 열기"></button></aside></div>';
  const body = document.querySelector(".sheet-body")!;
  const clicks = { rail: 0, collapse: 0 };
  const closed = () => { body.querySelector(".copilot")!.outerHTML = '<aside class="copilot collapsed"><button class="expand-copilot"></button></aside>'; body.querySelector(".expand-copilot")!.addEventListener("click", opened); };
  const opened = () => { clicks.rail++; body.querySelector(".copilot")!.outerHTML = '<aside class="copilot"><button class="ai-panel-collapse"></button><textarea></textarea></aside>'; body.querySelector(".ai-panel-collapse")!.addEventListener("click", () => { clicks.collapse++; closed(); }); };
  body.querySelector(".expand-copilot")!.addEventListener("click", opened);
  return { clicks };
}
const frame = () => new Promise(resolve => setTimeout(resolve, 30));
const lastOf = (post: ReturnType<typeof vi.fn>) => post.mock.calls.at(-1)![0] as EditorAiReport;
afterEach(() => { document.body.replaceChildren(); });

describe("the editors' own AI panel as 문서 AI", () => {
  // Release re-review 1, next round item 1: after 보이기 off → on, Markdown's rail swallowed the first click made the moment
  // it appeared, and the panel needed a second press. The tab's wish keeps pressing (a few times, a frame apart) until it is open.
  it("presses the rail again when its first click is swallowed (Markdown just after 보이기 was turned back on)", async () => {
    const { dock, clicks } = dockEditor();
    const rail = dock.querySelector<HTMLElement>(".ai-rail")!;
    let swallowed = 0;
    rail.addEventListener("click", (event) => { if (swallowed === 0) { swallowed++; event.stopImmediatePropagation(); } }, { capture: true });
    const post = vi.fn();
    const editor = installEditorAiDock(document, { post });
    editor.set(true);
    for (let wait = 0; wait < 10 && !lastOf(post).open; wait++) await frame();
    expect(swallowed).toBe(1);
    expect(clicks.rail).toBe(1);
    expect(lastOf(post)).toMatchObject({ open: true, person: false });
    editor.dispose();
  });

  it("stops pressing when the person closes it meanwhile or the tab asks for closed", async () => {
    const { dock } = dockEditor();
    const rail = dock.querySelector<HTMLElement>(".ai-rail")!;
    let presses = 0;
    rail.addEventListener("click", (event) => { presses++; event.stopImmediatePropagation(); }, { capture: true });
    const post = vi.fn();
    const editor = installEditorAiDock(document, { post });
    editor.set(true);
    editor.set(false);
    for (let wait = 0; wait < 6; wait++) await frame();
    expect(presses).toBe(1);
    editor.dispose();
  });

  it("reports itself drawn and closed at once, then opens and closes through its own keys when the tab asks", async () => {
    const { clicks } = dockEditor();
    const post = vi.fn();
    const dock = installEditorAiDock(document, { post });
    expect(lastOf(post)).toMatchObject({ type: "office:ai-panel", ready: true, open: false, shown: false, person: false, off: false });
    dock.set(true);
    await frame();
    expect(clicks.rail).toBe(1);
    expect(lastOf(post)).toMatchObject({ open: true, shown: true, person: false });
    dock.set(true);
    expect(clicks.rail).toBe(1);
    dock.set(false);
    await frame();
    expect(clicks.collapse).toBe(1);
    expect(lastOf(post)).toMatchObject({ open: false, person: false });
    dock.dispose();
  });

  it("says when the person opened or closed it with its own key (the tab's 문서 AI follows)", async () => {
    dockEditor();
    const post = vi.fn();
    const dock = installEditorAiDock(document, { post });
    (document.querySelector(".ai-rail") as HTMLElement).click();
    await frame();
    expect(lastOf(post)).toMatchObject({ open: true, person: true });
    (document.querySelector(".ai-panel-collapse") as HTMLElement).click();
    await frame();
    expect(lastOf(post)).toMatchObject({ open: false, person: true });
    dock.dispose();
  });

  it("drives Excel's panel (aside.copilot) the same way", async () => {
    const { clicks } = sheetsEditor();
    const post = vi.fn();
    const dock = installEditorAiDock(document, { post });
    expect(lastOf(post)).toMatchObject({ ready: true, open: false });
    dock.set(true); await frame();
    expect(clicks.rail).toBe(1);
    expect(lastOf(post)).toMatchObject({ open: true, person: false });
    dock.set(false); await frame();
    expect(clicks.collapse).toBe(1);
    expect(lastOf(post)).toMatchObject({ open: false, person: false });
    dock.dispose();
  });

  it("reports `off` when the person turned the panel off (no rail key): the tab opens the column instead", async () => {
    dockEditor(false, true);
    const post = vi.fn();
    const dock = installEditorAiDock(document, { post });
    expect(lastOf(post)).toMatchObject({ off: true, open: false });
    document.querySelector(".ai-dock")!.classList.remove("ai-dock-off");
    await frame();
    expect(lastOf(post)).toMatchObject({ off: false });
    dock.dispose();
  });

  it("puts the document's one draft in the panel's input in place of what it held", async () => {
    dockEditor(true);
    const post = vi.fn();
    const dock = installEditorAiDock(document, { post });
    const box = document.querySelector("textarea")!;
    box.value = "예전 글";
    dock.put("새 초안");
    expect(box.value).toBe("새 초안");
    expect(lastOf(post)).toMatchObject({ draft: "새 초안" });
    dock.dispose();
  });
});
