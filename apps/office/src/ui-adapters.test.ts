// @vitest-environment jsdom
import { fireEvent, within } from "@testing-library/react";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adaptOfficeCommands, applyOfficeTheme, mountOfficeUi, officeUiAdapters, type OfficeUiFormat } from "./ui-adapters.ts";
import { connectOfficeUi } from "./ui-adapters/connect.ts";
import { enhanceCustomSelects } from "../../../third_party/hop/custom-select.ts";
import type { Init } from "./bridge.ts";

// Vitest stubs CSS imports by default; use the actual raw stylesheet for the
// injection contract and selector-isolation checks below. Vite serves ?raw in-app.
vi.mock("./ui-adapters/chrome.css?raw", async () => {
  const { readFileSync } = await import("node:fs");
  return { default: readFileSync("apps/office/src/ui-adapters/chrome.css", "utf8") };
});
vi.mock("./ui-adapters/hangul-studio.css?raw", async () => {
  const { readFileSync } = await import("node:fs");
  return { default: readFileSync("apps/office/src/ui-adapters/hangul-studio.css", "utf8") };
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

// The custom properties a document's root ends up with from the style sheets that match it,
// with var() references resolved; the same reading is used for the app and the editor.
function rootTokens(doc: Document): Map<string, string> {
  const raw = new Map<string, string>();
  const read = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      // @media blocks (coarse pointer, more contrast, forced colours) are not the default screen.
      if (!("selectorText" in rule)) continue;
      const style = (rule as CSSStyleRule).style;
      let matches = false;
      try { matches = doc.documentElement.matches((rule as CSSStyleRule).selectorText); } catch { /* selector jsdom cannot read */ }
      if (!matches) continue;
      for (let i = 0; i < style.length; i++) if (style[i].startsWith("--")) raw.set(style[i], style.getPropertyValue(style[i]).trim());
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) read(sheet.cssRules);
  const resolve = (value: string, depth = 0): string => depth > 8 ? value : value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(raw.get(name) ?? `var(${name})`, depth + 1));
  return new Map([...raw].map(([name, value]) => [name, resolve(value)]));
}
async function appTokens(theme: "light" | "dark") {
  const { readFileSync } = await import("node:fs");
  // A document with a browsing context, so its style sheet is parsed (as the app's is).
  const frame = document.createElement("iframe"); frame.id = "app-tokens"; document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.documentElement.setAttribute("data-theme", theme);
  const style = doc.createElement("style"); style.textContent = readFileSync("apps/web/src/styles/foundation.css", "utf8"); doc.head.append(style);
  const tokens = rootTokens(doc); frame.remove();
  return tokens;
}
const STUDIO = '<div id="menu-bar"><div class="menu-item open" data-menu="view"><span class="menu-title">보기</span><div class="menu-dropdown">'
  + '<div class="md-item" data-cmd="view:zoom-in"><span class="md-label">확대</span></div><div class="md-sep"></div>'
  + '<div class="md-sub"><span class="md-label">테마</span><div class="md-sub-panel"><div class="md-item" data-cmd="view:theme-dark" data-theme-mode-choice="dark">다크</div><div class="md-item" data-cmd="view:skin-flat" data-theme-skin-choice="flat">플랫</div></div></div>'
  + '<div class="md-sep"></div><div class="md-item" data-cmd="view:ctrl-mark"><span class="md-label">조판 부호</span></div></div></div></div>'
  + '<div id="icon-toolbar"><button>저장</button></div><div id="style-bar"><select class="sb-combo"><option>바탕글</option></select></div>'
  + '<div id="scroll-container"><canvas></canvas></div><div id="status-bar"></div><div class="context-menu"></div><div class="modal-overlay"><div class="dialog-wrap"></div></div>';

// The studio's own token sheet (rhwp-studio base.css), from the pinned source the studio build unpacks.
function studioBaseCss(): string {
  const cache = "vendor/ieumoffice/apps/hwp/node_modules/.cache/rhwp-studio";
  const versions = existsSync(cache) ? readdirSync(cache).filter(name => existsSync(`${cache}/${name}/rhwp-studio/src/styles/base.css`)) : [];
  if (versions.length !== 1) throw new Error(`rhwp-studio source not found once under ${cache} (run node scripts/build-hwp-studio.mjs): ${versions.join(", ")}`);
  return readFileSync(`${cache}/${versions[0]}/rhwp-studio/src/styles/base.css`, "utf8");
}
// The document's own drawing (paper, ink, caret, selection, page shadow) and what is not a chrome colour.
const STUDIO_OWN = new Set(["--doc-paper", "--doc-shadow", "--caret-color", "--selection-fill", "--table-selection-fill", "--table-selection-stroke", "--table-selection-marker-range", "--table-selection-marker-single",
  "--ui-icon-sprite-url", "--ui-align-icon-filter", "--font-family-ui", "--font-family-mono",
  // Status tints and the modal scrim keep the studio's values: the app has no warning token, and these sit on their own surfaces.
  "--ui-warning-bg", "--ui-warning-border", "--ui-warning-text", "--ui-danger-soft", "--ui-on-accent-overlay", "--overlay-bg"]);
const NOT_COLOUR = /^--(space-|font-size-|radius-|control-height-|touch-target-)/;
const hexes = (value: string) => (value.match(/#[0-9a-f]{3,8}\b/gi) ?? []).map(hex => hex.toLowerCase());

it("gives the HWP studio the app's own light and dark tokens on every surface, and leaves paper, ink and selection alone", async () => {
  document.body.innerHTML = '<div class="hwp-editor-host"><iframe></iframe></div>';
  const frame = document.querySelector<HTMLIFrameElement>(".hwp-editor-host iframe")!, inner = frame.contentDocument!;
  inner.body.innerHTML = STUDIO;
  const base = inner.createElement("style"); base.textContent = studioBaseCss(); inner.head.append(base);
  // The studio's own values, before the app's skin is on.
  const own = { light: rootTokens(inner), dark: new Map<string, string>() };
  inner.documentElement.setAttribute("data-theme-effective", "dark"); own.dark = rootTokens(inner); inner.documentElement.removeAttribute("data-theme-effective");
  const tokens = [...own.light.keys()].filter(name => !NOT_COLOUR.test(name) && !STUDIO_OWN.has(name));
  expect(tokens.length).toBeGreaterThan(70);
  mount("hangul");
  fireEvent.load(frame);
  // The chrome's colours are the app's own (chrome.css), so a studio token drawn from them is the app's.
  const palette: [chrome: string, app: string][] = [["--wb-ui-bg", "--surface"], ["--wb-ui-group", "--chrome-bg"], ["--wb-ui-text", "--text"], ["--wb-ui-muted", "--muted"], ["--wb-ui-line", "--line"],
    ["--wb-ui-focus", "--accent"], ["--wb-ui-on-accent", "--on-action"], ["--wb-ui-hover", "--surface-muted"], ["--wb-ui-selected", "--accent-soft"], ["--wb-ui-danger", "--danger"]];
  const unchanged = new Set(tokens);
  for (const theme of ["light", "dark"] as const) {
    await applyOfficeTheme("view", theme);
    // The studio marks its own dark theme this way when the app's theme reaches it.
    if (theme === "dark") inner.documentElement.setAttribute("data-theme-effective", "dark"); else inner.documentElement.removeAttribute("data-theme-effective");
    const studio = rootTokens(inner), app = await appTokens(theme);
    for (const [chrome, role] of palette) expect([theme, chrome, studio.get(chrome)]).toEqual([theme, chrome, app.get(role)]);
    const colours = new Set(palette.flatMap(([chrome]) => hexes(studio.get(chrome)!)));
    // Every chrome token of the studio, read from its own sheet: drawn only from the app's colours, not the studio's.
    for (const token of tokens) {
      const value = studio.get(token) ?? "";
      expect([theme, token, hexes(value).length > 0 && hexes(value).every(hex => colours.has(hex)) && !/rgba?\(/.test(value)], value).toEqual([theme, token, true]);
      if (value !== own[theme].get(token)) unchanged.delete(token);
    }
    expect(studio.get("--font-family-ui")).toContain("Pretendard Variable");
    // Paper, ink, caret and selection are the document's, in both themes.
    for (const token of ["--doc-paper", "--caret-color", "--selection-fill", "--table-selection-fill"]) expect([theme, token, studio.get(token)]).toEqual([theme, token, own[theme].get(token)]);
  }
  // No chrome token keeps the studio's own value in both themes.
  expect([...unchanged]).toEqual([]);
  // Every studio surface is one of the skinned chrome surfaces.
  const style = inner.querySelector<HTMLStyleElement>("style[data-wb-office-chrome]")!;
  const surface = Array.from(style.sheet!.cssRules).find(rule => "selectorText" in rule && rule.cssText.includes("font-family: var(--wb-ui-font) !important")) as CSSStyleRule;
  for (const selector of ["#menu-bar", ".menu-dropdown", "#icon-toolbar", "#style-bar", "#status-bar", ".context-menu", ".dialog-wrap"]) {
    expect([selector, inner.querySelector(selector)!.matches(surface.selectorText)]).toEqual([selector, true]);
  }
});

// sRGB colour of a resolved token value: #hex, transparent, or color-mix(in srgb, a p%, b).
type Rgba = [number, number, number, number];
function colour(value: string, under: Rgba = [255, 255, 255, 1]): Rgba {
  const v = value.trim();
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map(at => parseInt(hex[1].slice(at, at + 2), 16)).concat(1) as Rgba;
  const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  const mix = /^color-mix\(in srgb,\s*(.+)\)$/.exec(v);
  if (!mix) throw new Error(`not a colour: ${v}`);
  // Split the two arguments at the top-level comma.
  let depth = 0, cut = -1;
  for (let i = 0; i < mix[1].length; i++) { const c = mix[1][i]; if (c === "(") depth++; else if (c === ")") depth--; else if (c === "," && depth === 0) { cut = i; break; } }
  const part = (text: string) => { const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/.exec(text.trim())!; return { c: colour(m[1], under), p: m[2] === undefined ? undefined : Number(m[2]) / 100 }; };
  const a = part(mix[1].slice(0, cut)), b = part(mix[1].slice(cut + 1));
  const pa = a.p ?? (b.p === undefined ? .5 : 1 - b.p), pb = 1 - pa;
  const alpha = a.c[3] * pa + b.c[3] * pb;
  const ch = (i: number) => alpha === 0 ? 0 : (a.c[i] * a.c[3] * pa + b.c[i] * b.c[3] * pb) / alpha;
  return [ch(0), ch(1), ch(2), alpha];
}
const over = (top: Rgba, back: Rgba): Rgba => [0, 1, 2].map(i => top[i] * top[3] + back[i] * (1 - top[3])).concat(1) as Rgba;
const luminance = ([r, g, b]: Rgba) => [r, g, b].map(c => { const s = c / 255; return s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
const contrast = (a: Rgba, b: Rgba) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };

it("marks the drop-down row the arrow keys are on clearly in both themes, apart from the chosen row", async () => {
  document.body.innerHTML = '<div class="hwp-editor-host"><iframe></iframe></div>';
  const frame = document.querySelector<HTMLIFrameElement>(".hwp-editor-host iframe")!, inner = frame.contentDocument!;
  inner.body.innerHTML = '<div id="style-bar"><select id="linespacing-select" class="sb-ls-select" title="줄 간격"><option>100 %</option><option selected>160 %</option><option>180 %</option><option>200 %</option></select></div>';
  mount("hangul");
  fireEvent.load(frame);
  enhanceCustomSelects(inner);
  const view = inner.defaultView!, trigger = inner.querySelector<HTMLElement>(".custom-select-trigger")!;
  trigger.dispatchEvent(new view.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  trigger.dispatchEvent(new view.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  const rows = Array.from(inner.querySelectorAll<HTMLElement>(".custom-select-option"));
  const active = rows.find(row => row.classList.contains("active"))!, chosen = rows.find(row => row.getAttribute("aria-selected") === "true")!;
  expect([active.textContent, chosen.textContent]).toEqual(["180 %", "160 %"]);
  for (const theme of ["light", "dark"] as const) {
    await applyOfficeTheme("view", theme);
    const tokens = rootTokens(inner);
    const resolve = (value: string) => value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => tokens.get(name) ?? "");
    // Declared values of the rules that match, in sheet order (jsdom drops a var() background shorthand
    // from computed style); the studio's rules here have no competing specificity.
    const style = (element: Element) => {
      const found: Record<string, string> = { background: "transparent", color: "", "box-shadow": "none" };
      for (const sheet of Array.from(inner.styleSheets)) for (const rule of Array.from(sheet.cssRules)) {
        if (!("selectorText" in rule)) continue;
        let hit = false; try { hit = element.matches((rule as CSSStyleRule).selectorText); } catch { /* selector jsdom cannot read */ }
        if (!hit) continue;
        const declared = (rule as CSSStyleRule).style;
        for (const name of Object.keys(found)) { const value = declared.getPropertyValue(name) || (name === "background" ? declared.getPropertyValue("background-color") : ""); if (value) found[name] = value.replace(/\s*!important$/, ""); }
      }
      return { back: resolve(found.background), text: resolve(found.color), ring: resolve(found["box-shadow"]) };
    };
    const list = colour(style(inner.querySelector(".custom-select-menu")!).back);
    const ring = (row: Element) => /^inset 0 0 0 2px (.+)$/.exec(style(row).ring)?.[1];
    const a = style(active), back = over(colour(a.back), list);
    // The active row: a ring of at least 3:1 against the list, its text at least 4.5:1 on the row.
    expect([theme, ring(active) ? contrast(colour(ring(active)!), back) >= 3 : "no ring"]).toEqual([theme, true]);
    expect([theme, contrast(colour(a.text), back) >= 4.5]).toEqual([theme, true]);
    // The chosen row is told apart from the active one: a fill, no ring.
    expect([theme, ring(chosen)]).toEqual([theme, undefined]);
    expect([theme, style(chosen).back === a.back]).toEqual([theme, false]);
  }
});

it("keeps one theme switch: the studio's own theme and skin menu is not offered inside the editor", () => {
  document.body.innerHTML = '<div class="hwp-editor-host"><iframe></iframe></div>';
  const frame = document.querySelector<HTMLIFrameElement>(".hwp-editor-host iframe")!, inner = frame.contentDocument!;
  inner.body.innerHTML = STUDIO;
  mount("hangul");
  fireEvent.load(frame);
  const view = inner.defaultView!;
  const sub = inner.querySelector(".md-sub")!, seps = inner.querySelectorAll(".md-sep");
  expect(view.getComputedStyle(sub).display).toBe("none");
  // The separator above it goes too, so no doubled line is left; the other items stay.
  expect(view.getComputedStyle(seps[0]).display).toBe("none");
  expect(view.getComputedStyle(seps[1]).display).not.toBe("none");
  expect(view.getComputedStyle(inner.querySelector('[data-cmd="view:ctrl-mark"]')!).display).not.toBe("none");
});

it("does not list a drop-down as an editor command (a press on it would do nothing)", () => {
  document.body.innerHTML = '<div class="hwp-editor-host"><iframe></iframe></div>';
  const frame = document.querySelector("iframe")!, inner = frame.contentDocument!;
  inner.body.innerHTML = '<div id="style-bar"><button type="button" role="combobox" aria-label="글꼴 모양 고르기">함초롬바탕</button><button title="글꼴 진하게">가</button></div>';
  for (const button of inner.querySelectorAll("button")) button.getClientRects = () => [{}] as unknown as DOMRectList;
  const ui = mount("hangul");
  fireEvent.load(frame);
  ui.show();
  search(ui.dialog, "글꼴");
  expect(ui.screen.queryByRole("button", { name: /글꼴 진하게/ })).not.toBeNull();
  expect(ui.screen.queryByRole("button", { name: /글꼴 모양 고르기/ })).toBeNull();
});

it("keeps the Hangul editor's AI dock as the one entry: shown when open, no width and no rail of its own when closed", () => {
  document.body.innerHTML = '<div class="hwp-app"><div class="hwp-topbar"><button>메모</button></div><div class="app-main"><div class="ai-dock"><div class="copilot"><textarea></textarea></div></div><div class="memo-side"></div><div class="hwp-editor-host"><iframe></iframe></div></div></div>';
  mount("hangul");
  const dock = document.querySelector<HTMLElement>(".ai-dock")!;
  // Open: the dock (the editor's own AI, with selection scope, live edits and its executor) is there.
  expect(getComputedStyle(dock).display).not.toBe("none");
  expect(getComputedStyle(document.querySelector(".hwp-topbar")!).display).not.toBe("none");
  expect(getComputedStyle(document.querySelector(".memo-side")!).display).not.toBe("none");
  // Closed: the tab's 문서 AI button is the way in; the dock's own rail is not a second entry and takes no width.
  dock.classList.add("collapsed");
  dock.insertAdjacentHTML("afterbegin", '<button class="ai-rail ai-entry" aria-label="문서 AI">AI</button>');
  expect(getComputedStyle(dock).width).toBe("0px");
  expect(getComputedStyle(document.querySelector(".ai-rail")!).display).toBe("none");
  dispose?.(); dispose = undefined;
  // Other editors keep their own AI panels and rails (this unit changes only the Hangul editor).
  document.body.innerHTML = '<div class="ai-dock collapsed"><button class="ai-rail">AI</button></div><div class="ribbon"><button>원본 도구</button></div>';
  mount("word");
  expect(getComputedStyle(document.querySelector(".ai-rail")!).display).not.toBe("none");
});

// The studio's small things in both themes (H1 follow-ups): what each element ends up with from the
// cascade (specificity, then order), the studio's base sheet and Ieum's dialog theme included.
function specificity(selector: string): number {
  let s = selector.replace(/::?(?:before|after)\b/g, "");
  let total = 0;
  // :where() counts nothing; :is() / :not() count their highest argument.
  s = s.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "");
  s = s.replace(/:(?:is|not|has)\(((?:[^()]|\([^()]*\))*)\)/g, (_, inner: string) => { total += Math.max(...inner.split(",").map(specificity)); return ""; });
  total += (s.match(/#[\w-]+/g)?.length ?? 0) * 10000;
  total += ((s.match(/\.[\w-]+/g)?.length ?? 0) + (s.match(/\[[^\]]*\]/g)?.length ?? 0) + (s.match(/:[\w-]+/g)?.length ?? 0)) * 100;
  total += s.replace(/\[[^\]]*\]/g, "").split(/[\s>+~]+/).filter(part => /^[a-z]/i.test(part)).length;
  return total;
}
const topLevel = (list: string) => { const out: string[] = []; let depth = 0, from = 0; for (let i = 0; i < list.length; i++) { const c = list[i]; if (c === "(") depth++; else if (c === ")") depth--; else if (c === "," && depth === 0) { out.push(list.slice(from, i)); from = i + 1; } } out.push(list.slice(from)); return out.map(part => part.trim()); };
/** The value of `name` the cascade gives `element` (`pseudo`: ::after), var() resolved with the root's tokens. */
function cascaded(element: Element, name: string, tokens: Map<string, string>, pseudo = ""): string {
  let best: { important: boolean; spec: number; order: number; value: string } | null = null, order = 0;
  for (const sheet of Array.from(element.ownerDocument.styleSheets)) for (const rule of Array.from(sheet.cssRules)) {
    order++;
    if (!("selectorText" in rule)) continue;
    const style = (rule as CSSStyleRule).style;
    const value = style.getPropertyValue(name) || (name === "background-color" ? style.getPropertyValue("background") : "");
    if (!value) continue;
    for (const selector of topLevel((rule as CSSStyleRule).selectorText)) {
      const isPseudo = /::?(?:before|after)$/.test(selector);
      if (isPseudo !== Boolean(pseudo) || (pseudo && !selector.endsWith(pseudo))) continue;
      let hit = false; try { hit = element.matches(selector.replace(/::?(?:before|after)$/, "")); } catch { /* selector jsdom cannot read */ }
      if (!hit) continue;
      const important = style.getPropertyPriority(name) === "important" || /!important/.test(value);
      const candidate = { important, spec: specificity(selector), order, value: value.replace(/\s*!important$/, "") };
      if (!best || (candidate.important !== best.important ? candidate.important : candidate.spec !== best.spec ? candidate.spec > best.spec : candidate.order >= best.order)) best = candidate;
    }
  }
  const resolve = (text: string, depth = 0): string => depth > 8 ? text : text.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g, (_, token: string, fallback?: string) => resolve(tokens.get(token) ?? fallback ?? "", depth + 1));
  return best ? resolve(best.value).trim() : "";
}
const SMALL_THINGS = '<div id="menu-bar"><div class="menu-item open"><span class="menu-title">편집</span><div class="menu-dropdown">'
  + '<div class="md-item disabled" data-cmd="edit:undo"><span class="md-label">되돌리기</span><span class="md-shortcut">Ctrl+Z</span></div>'
  + '<div class="md-sub disabled"><span class="md-label">채우기</span><span class="md-arrow">▶</span></div></div></div></div>'
  + '<div class="modal-overlay"><div class="dialog-wrap"><div class="dialog-body"><div class="dialog-section"><div class="dialog-row"><span class="dialog-label">위</span><input class="dialog-input"><span class="dialog-unit">mm</span></div>'
  + '<label class="dialog-checkbox"><input type="checkbox" id="zz-box"> 대소문자 구분</label><label class="dialog-checkbox"><input type="checkbox" id="zz-on" checked> 켜짐</label>'
  + '<div class="dialog-radio-group"><label><input type="radio" name="r" id="zz-radio"> 글자</label><label><input type="radio" name="r" id="zz-radio-on" checked> 문단</label></div></div></div></div></div>';
async function smallThings() {
  document.body.innerHTML = '<div class="hwp-editor-host"><iframe></iframe></div>';
  const frame = document.querySelector<HTMLIFrameElement>(".hwp-editor-host iframe")!, inner = frame.contentDocument!;
  inner.body.innerHTML = SMALL_THINGS;
  const base = inner.createElement("style"); base.textContent = studioBaseCss() + "\n" + readFileSync(studioStyle("menu-bar.css"), "utf8") + "\n" + readFileSync(studioStyle("dialogs.css"), "utf8"); inner.head.append(base);
  // Ieum's dialog skin, as its studio plugin installs it in the studio frame.
  const { installDialogTheme } = await import("../../../vendor/ieumoffice/apps/hwp/studio-plugin/dialog-theme.mjs" as string) as { installDialogTheme(doc: Document): boolean };
  installDialogTheme(inner);
  mount("hangul");
  fireEvent.load(frame);
  const themes = async function* () {
    for (const theme of ["light", "dark"] as const) {
      await applyOfficeTheme("view", theme);
      if (theme === "dark") inner.documentElement.setAttribute("data-theme-effective", "dark"); else inner.documentElement.removeAttribute("data-theme-effective");
      yield { theme, tokens: rootTokens(inner) };
    }
  };
  return { inner, themes };
}
function studioStyle(name: string): string {
  const cache = "vendor/ieumoffice/apps/hwp/node_modules/.cache/rhwp-studio";
  const version = readdirSync(cache).find(entry => existsSync(`${cache}/${entry}/rhwp-studio/src/styles/${name}`));
  return `${cache}/${version}/rhwp-studio/src/styles/${name}`;
}

it("draws dialog check boxes and radio buttons on the theme in dark and light (no white slab), the choice in the app's accent", async () => {
  const { inner, themes } = await smallThings();
  for await (const { theme, tokens } of themes()) {
    const surface = colour(cascaded(inner.querySelector(".dialog-wrap")!, "background-color", tokens) || tokens.get("--wb-ui-bg")!);
    for (const id of ["zz-box", "zz-radio", "zz-on", "zz-radio-on"]) {
      const box = inner.getElementById(id)!, on = id.endsWith("-on");
      // Drawn by the page, not by the platform's own (light) widget.
      expect([theme, id, cascaded(box, "appearance", tokens) || cascaded(box, "-webkit-appearance", tokens)]).toEqual([theme, id, "none"]);
      // A box, not a 28 px (touch: 44 px) rounded control: the app's control size is for buttons and fields.
      expect([theme, id, parseFloat(cascaded(box, "min-width", tokens)), parseFloat(cascaded(box, "min-height", tokens))]).toEqual([theme, id, 0, 0]);
      const fill = over(colour(cascaded(box, "background-color", tokens)), surface);
      const edge = colour(cascaded(box, "border-color", tokens) || "transparent");
      // Its fill follows the theme (dark in dark), its edge or fill stands out from the dialog at least 3:1.
      expect([theme, id, theme === "dark" ? luminance(fill) < .1 || on : luminance(fill) > .3 || on]).toEqual([theme, id, true]);
      expect([theme, id, Math.max(contrast(fill, surface), edge[3] ? contrast(over(edge, surface), surface) : 0) >= 3]).toEqual([theme, id, true]);
      if (on) {
        expect([theme, id, contrast(fill, colour(tokens.get("--wb-ui-focus")!)) < 1.01]).toEqual([theme, id, true]);
        const mark = cascaded(box, id.startsWith("zz-radio") ? "background-color" : "border-color", tokens, "::after");
        expect([theme, id, mark ? contrast(colour(mark), fill) >= 3 : "no mark"]).toEqual([theme, id, true]);
      }
    }
  }
});

it("keeps the shortcut and sub-menu arrow of a disabled menu row at least 3:1 in both themes", async () => {
  const { inner, themes } = await smallThings();
  for await (const { theme, tokens } of themes()) {
    const menu = colour(cascaded(inner.querySelector(".menu-dropdown")!, "background-color", tokens) || tokens.get("--wb-ui-bg")!);
    for (const selector of [".md-item.disabled .md-shortcut", ".md-sub.disabled .md-arrow"]) {
      const value = cascaded(inner.querySelector(selector)!, "color", tokens);
      expect([theme, selector, contrast(over(colour(value), menu), menu) >= 3]).toEqual([theme, selector, true]);
    }
  }
});

it("keeps unit labels (mm, pt, %) in dialogs at least 4.5:1 on every dialog surface, light and dark", async () => {
  const { inner, themes } = await smallThings();
  for await (const { theme, tokens } of themes()) {
    const unit = colour(cascaded(inner.querySelector(".dialog-unit")!, "color", tokens));
    // The dialog, its sunken group boxes and its fields (Ieum's dialog theme).
    for (const surface of ["--ieum-dialog-surface", "--ieum-dialog-surface-sunken", "--ieum-dialog-field-surface"]) {
      const back = colour(tokens.get(surface)!);
      expect([theme, surface, Number(contrast(unit, back).toFixed(2)) >= 4.5]).toEqual([theme, surface, true]);
    }
  }
});
