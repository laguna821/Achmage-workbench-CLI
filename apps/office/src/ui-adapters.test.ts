// @vitest-environment jsdom
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adaptOfficeCommands, applyOfficeTheme, mountOfficeUi, officeUiAdapters, type OfficeUiFormat } from "./ui-adapters.ts";
import { connectOfficeUi } from "./ui-adapters/connect.ts";
import type { Init } from "./bridge.ts";

// Vitest stubs CSS imports by default; use the actual raw stylesheet for the
// injection contract and selector-isolation checks below. Vite serves ?raw in-app.
vi.mock("./ui-adapters/chrome.css?raw", async () => {
  const { readFileSync } = await import("node:fs");
  return { default: readFileSync("apps/office/src/ui-adapters/chrome.css", "utf8") };
});

const formats = Object.keys(officeUiAdapters) as OfficeUiFormat[];
const dialogMethods = Object.fromEntries(["showModal", "close"].map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  // jsdom has the element but not the browser's top-layer dialog methods.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => {
  dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks();
  for (const [name, descriptor] of Object.entries(dialogMethods)) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
function mount(format: OfficeUiFormat = "word", doc = document) {
  const onCommand = vi.fn(), onTheme = vi.fn();
  const ui = mountOfficeUi({ viewId: "view", format, theme: "light", onCommand, onTheme, doc });
  dispose = ui.dispose;
  const dialog = document.querySelector<HTMLDialogElement>(".wb-office-commands")!;
  return { ...ui, dialog, screen: within(dialog), onCommand, onTheme };
}
function search(dialog: HTMLElement, value: string) {
  fireEvent.input(within(dialog).getByRole("searchbox"), { target: { value } });
}

it("retains_every_existing_editor_command, including unknown advanced commands and their handlers", () => {
  const advanced = { id: "advanced-layout", run: vi.fn(), disabledReason: () => "잠긴 영역입니다." };
  for (const format of formats) {
    const commands = adaptOfficeCommands(format, [{ id: "save" }, { id: "undo" }, advanced]);
    expect(commands.map(command => command.commandId)).toEqual(["save", "undo", "advanced-layout"]);
    expect(commands[2].run).toBe(advanced.run);
    expect(commands[2].disabledReason?.()).toBe("잠긴 영역입니다.");
  }
});

it.each(formats)("%s runs the original file command and discovers a new live ribbon command", format => {
  document.body.innerHTML = '<div class="ribbon"><button aria-label="새 고급 명령">명령</button></div>';
  const original = document.querySelector("button")!, click = vi.fn(); original.addEventListener("click", click);
  const ui = mount(format);
  ui.show();
  const command = format === "pdf" ? "save-as" : "save";
  fireEvent.click(ui.dialog.querySelector(`[data-command-id="${command}"]`)!);
  expect(ui.onCommand).toHaveBeenCalledWith(command); expect(ui.dialog.open).toBe(false);
  ui.show(); search(ui.dialog, "새 고급 명령");
  fireEvent.click(ui.screen.getByRole("button", { name: /새 고급 명령/ }));
  expect(click).toHaveBeenCalledOnce();
  expect(document.querySelector(".ribbon button")).toBe(original);
});

it("keeps content, range and control identity while theme updates and command search opens", async () => {
  document.body.innerHTML = '<div class="ribbon"><button>원본 도구</button></div><div id="page" tabindex="0" contenteditable="true" style="color: red">저장하지 않은 본문</div>';
  const page = document.querySelector<HTMLElement>("#page")!, text = page.firstChild!;
  page.focus();
  const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 6);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  const ui = mount(), original = page.outerHTML;
  await expect(applyOfficeTheme("view", "dark")).resolves.toEqual({ remounted: false });
  expect(ui.onTheme).toHaveBeenCalledWith("dark");
  expect(document.querySelector(".wb-office-ui")?.getAttribute("data-theme")).toBe("dark");
  ui.show(); search(ui.dialog, "표 속성");
  const observed = vi.fn(() => {
    expect(document.activeElement).toBe(page);
    expect(document.getSelection()?.toString()).toBe("하지 않");
  });
  ui.onCommand.mockImplementation(observed);
  fireEvent.keyDown(ui.screen.getByRole("searchbox"), { key: "Enter" });
  expect(ui.onCommand).toHaveBeenCalledWith("table-properties");
  expect(observed).toHaveBeenCalledOnce();
  expect(document.querySelector("#page")).toBe(page); expect(page.outerHTML).toBe(original);
});

it("shows why an original control is disabled and leaves its handler untouched", () => {
  document.body.innerHTML = '<div class="ribbon"><button disabled data-disabled-reason="표를 먼저 선택해 주세요.">셀 병합</button></div>';
  const click = vi.fn(); document.querySelector("button")!.addEventListener("click", click);
  const ui = mount(); ui.show(); search(ui.dialog, "셀 병합");
  const button = ui.screen.getByRole("button", { name: /현재 리본/ });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(ui.screen.getByRole("status").textContent).toBe("표를 먼저 선택해 주세요.");
  expect(click).not.toHaveBeenCalled(); expect(ui.dialog.open).toBe(true);
});

it("preserves input caret, isolates renderer shortcuts and supports arrow navigation with IME", () => {
  document.body.innerHTML = '<div class="ribbon"><button>원본 도구</button></div><textarea>편집 중인 원문</textarea>';
  const field = document.querySelector("textarea")!; field.focus(); field.setSelectionRange(2, 5);
  const ui = mount(), rendererKey = vi.fn();
  window.addEventListener("keydown", rendererKey);
  try {
    fireEvent.keyDown(field, { key: "/", code: "Slash", altKey: true });
    const input = ui.screen.getByRole("searchbox");
    fireEvent.keyDown(input, { key: "Delete" }); expect(rendererKey).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true }); expect(ui.onCommand).not.toHaveBeenCalled();
    const rows = [...ui.dialog.querySelectorAll<HTMLButtonElement>(".wb-office-command")];
    rows.forEach(row => { row.scrollIntoView = vi.fn(); });
    fireEvent.keyDown(input, { key: "ArrowUp" }); expect(document.activeElement).toBe(rows.at(-1));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(field); expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(5);
  } finally { window.removeEventListener("keydown", rendererKey); }
});

it("finds HWP studio controls after its inner frame loads and restores its selection", async () => {
  document.body.innerHTML = '<div class="hwp-editor-host"><iframe></iframe></div>';
  const frame = document.querySelector("iframe")!, inner = frame.contentDocument!;
  inner.body.innerHTML = '<div role="toolbar"><button title="한글 표 나누기">표</button></div><textarea>한글 원문</textarea>';
  const button = inner.querySelector("button")!, click = vi.fn(); button.addEventListener("click", click);
  // This element comes from a different DOM realm.
  button.getClientRects = () => [{}] as unknown as DOMRectList;
  const field = inner.querySelector("textarea")!; field.focus(); field.setSelectionRange(1, 3);
  const ui = mount("hangul");
  fireEvent.load(frame);
  fireEvent.keyDown(field, { key: "/", code: "Slash", altKey: true });
  expect(ui.dialog.open).toBe(true);
  search(ui.dialog, "한글 표 나누기");
  fireEvent.click(ui.screen.getByRole("button", { name: /한글 표 나누기/ }));
  expect(click).toHaveBeenCalledOnce();
  expect(inner.activeElement).toBe(field); expect(field.selectionStart).toBe(1);
  ui.dispose(); dispose = undefined;
  await expect(applyOfficeTheme("view", "dark")).rejects.toThrow("아직 준비되지");
  expect(document.querySelector(".wb-office-ui")).toBeNull();
});

it("connects shell requests through the existing parent-origin bridge and cleans up on page exit", () => {
  document.body.innerHTML = '<div class="ribbon"><button>원본 도구</button></div>';
  const onTheme = vi.fn(), onCommand = vi.fn();
  const init = { type: "office:init", artifact: { id: "connected" }, theme: "light" } as Init;
  connectOfficeUi(init, "word", onCommand, onTheme);
  try {
    const message = (data: unknown, origin = location.origin) => window.dispatchEvent(new MessageEvent("message", { origin, source: window.parent, data }));
    const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
    message({ type: "office:show-commands" }, "http://foreign.test");
    expect(dialog.open).toBe(false);
    message({ type: "office:show-commands" }); expect(dialog.open).toBe(true);
    message({ type: "office:theme", theme: "dark" }); expect(onTheme).toHaveBeenCalledWith("dark");
    fireEvent.click(dialog.querySelector('[data-command-id="save"]')!);
    expect(onCommand).toHaveBeenCalledWith("save");
  } finally { window.dispatchEvent(new Event("pagehide")); }
  expect(document.querySelector(".wb-office-ui")).toBeNull();
});

it("skins actual chrome with an offline font without changing authored nodes, and removes the skin", async () => {
  document.documentElement.setAttribute("data-wb-office-theme", "original");
  document.body.innerHTML = '<div class="ribbon"><button>원본 도구</button></div><div class="ai-panel-header"><button>새 대화</button></div><div class="ai-composer"><textarea>질문 초안</textarea></div><div class="doc-page" style="font-family: serif; color: red"><div class="ribbon"><button style="font-family: Georgia">문서 안의 버튼</button></div>원문</div>';
  const page = document.querySelector(".doc-page")!, original = page.outerHTML;
  const chrome = document.querySelector(".ribbon")!, control = chrome.querySelector("button")!;
  const ui = mount();
  const style = document.querySelector<HTMLStyleElement>('style[data-wb-office-chrome="word"]')!;
  expect(style.textContent).toContain(new URL("/office/fonts/pretendard/PretendardVariable.ttf", document.location.href).href);
  expect(style.textContent).toContain(".ai-panel-header, .ai-composer, .ai-model-picker");
  expect(style.textContent).not.toMatch(/__WB_/);
  expect(document.documentElement.dataset.wbOfficeFormat).toBe("word");
  const surfaceRule = Array.from(style.sheet!.cssRules).find(rule => "selectorText" in rule && String(rule.selectorText).includes(".ribbon") && rule.cssText.includes("font-family: var(--wb-ui-font) !important")) as CSSStyleRule;
  expect(chrome.matches(surfaceRule.selectorText)).toBe(true);
  expect(page.querySelector(".ribbon")!.matches(surfaceRule.selectorText)).toBe(false);
  await applyOfficeTheme("view", "dark");
  expect(document.documentElement.dataset.wbOfficeTheme).toBe("dark");
  expect(page.outerHTML).toBe(original);
  expect(chrome.querySelector("button")).toBe(control);
  expect(document.querySelector(".ai-composer textarea")?.textContent).toBe("질문 초안");
  ui.dispose(); dispose = undefined;
  expect(document.querySelector("style[data-wb-office-chrome]")).toBeNull();
  expect(document.documentElement.hasAttribute("data-wb-office-format")).toBe(false);
  expect(document.documentElement.dataset.wbOfficeTheme).toBe("original");
  document.documentElement.removeAttribute("data-wb-office-theme");
});

it("installs and themes only the HWP editor frame, then restores both documents", async () => {
  document.body.innerHTML = '<div class="hwp-editor-host"><iframe></iframe></div><iframe id="preview"></iframe>';
  const frame = document.querySelector<HTMLIFrameElement>(".hwp-editor-host iframe")!, inner = frame.contentDocument!;
  inner.body.innerHTML = '<div id="menu-bar"><button>파일</button></div><div id="icon-toolbar"><button>저장</button></div><canvas></canvas>';
  const original = inner.body.innerHTML;
  const ui = mount("hangul");
  fireEvent.load(frame);
  expect(inner.querySelector("style[data-wb-office-chrome]")?.textContent).toContain("#icon-toolbar, #style-bar, #status-bar");
  expect(document.querySelector<HTMLIFrameElement>("#preview")!.contentDocument!.querySelector("style[data-wb-office-chrome]")).toBeNull();
  await applyOfficeTheme("view", "dark");
  expect(inner.documentElement.dataset.wbOfficeTheme).toBe("dark");
  expect(inner.body.innerHTML).toBe(original);
  ui.dispose(); dispose = undefined;
  expect(inner.querySelector("style[data-wb-office-chrome]")).toBeNull();
  expect(inner.documentElement.hasAttribute("data-wb-office-format")).toBe(false);
});
