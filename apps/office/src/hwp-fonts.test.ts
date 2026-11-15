// @vitest-environment jsdom
// HOP's HY / 휴먼 authoring rule (MIT; third_party/hop/LICENSE) and its use in the studio frame.
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterAuthoringFontFamilies, installedFontKeys, isAuthoringBlockedFontFamily, sanitizeAuthoringFontFamily } from "../../../third_party/hop/font-authoring-policy.ts";
import { HWP_FALLBACK_FACES, installHwpFontRule, type FaceRegistration } from "./hwp-fonts.ts";
import type { HostFontSnapshot } from "../../../packages/contracts/src/hwp-fonts.ts";

describe("font authoring policy (HOP)", () => {
  it("blocks proprietary Hancom and Human authoring families", () => {
    expect(isAuthoringBlockedFontFamily("HY헤드라인M")).toBe(true);
    expect(isAuthoringBlockedFontFamily("HYHeadLine M")).toBe(true);
    expect(isAuthoringBlockedFontFamily("휴먼명조")).toBe(true);
    expect(isAuthoringBlockedFontFamily("HCI Poppy")).toBe(true);
    expect(isAuthoringBlockedFontFamily("Happiness Sans Regular")).toBe(false);
    expect(isAuthoringBlockedFontFamily("함초롬바탕")).toBe(false);
  });
  it("normalizes blocked authoring families to safe substitutes", () => {
    expect(sanitizeAuthoringFontFamily("HY헤드라인M")).toBe("함초롬돋움");
    expect(sanitizeAuthoringFontFamily("휴먼명조")).toBe("함초롬바탕");
    expect(sanitizeAuthoringFontFamily("HY견명조")).toBe("함초롬바탕");
    expect(filterAuthoringFontFamilies(["HY헤드라인M", "나눔고딕"])).toEqual(["나눔고딕"]);
  });
  it("allows a blocked family that is really installed", () => {
    const installed = installedFontKeys(["HY견고딕"]);
    expect(isAuthoringBlockedFontFamily("HY 견고딕", installed)).toBe(false);
    expect(sanitizeAuthoringFontFamily("HY견고딕", installed)).toBe("HY견고딕");
    expect(filterAuthoringFontFamilies(["HY견고딕", "HY견명조"], installed)).toEqual(["HY견고딕"]);
  });
  it("counts a font installed under its English name as installed for its Korean name, and the other way round", () => {
    expect(isAuthoringBlockedFontFamily("HY견고딕", installedFontKeys(["HYGothic-Extra"]))).toBe(false);
    expect(isAuthoringBlockedFontFamily("HYGothic-Extra", installedFontKeys(["HY견고딕"]))).toBe(false);
    expect(isAuthoringBlockedFontFamily("HY헤드라인M", installedFontKeys(["HYHeadLine Medium"]))).toBe(false);
    expect(isAuthoringBlockedFontFamily("HY견명조", installedFontKeys(["HYMyeongJo-Extra"]))).toBe(false);
    expect(isAuthoringBlockedFontFamily("HY견명조", installedFontKeys(["HYGothic-Extra"]))).toBe(true);
  });
});

const face = (family: string, aliases: string[] = []) => ({ id: family, family, fullName: family, postscriptName: family, style: "Regular", aliases });
const snapshot = (...families: string[]): HostFontSnapshot => ({ revision: "r", faces: families.map(name => face(name)) });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function studio() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = `<div id="style-bar"><select id="font-name" class="sb-combo">
    ${["함초롬바탕", "함초롬돋움", "맑은 고딕", "HY견고딕", "HY견명조"].map(name => `<option value="${name}">${name}</option>`).join("")}
  </select></div>`;
  const select = doc.getElementById("font-name") as HTMLSelectElement;
  select.value = "HY견명조"; // the caret is in text the document sets in HY견명조
  // The studio's own picker, as it builds it on open.
  const openPicker = (category: string, names: string[]) => {
    doc.querySelector(".font-picker-menu")?.remove();
    doc.body.insertAdjacentHTML("beforeend", `<div class="font-picker-menu" role="dialog"><div class="font-picker-categories">
      <button class="font-picker-category${category === "current" ? " active" : ""}" data-category="current">현재 글꼴</button>
      <button class="font-picker-category${category === "all" ? " active" : ""}" data-category="all">모든 글꼴</button></div>
      <div><div class="font-picker-heading" data-role="heading">${category === "all" ? "모든 글꼴" : "현재 글꼴"} (${names.length})</div>
      <div class="font-picker-list" data-role="list" role="listbox">${names.map(name => `<button class="font-picker-option" role="option">${name}</button>`).join("")}</div></div></div>`);
  };
  return { doc, select, openPicker };
}
const offered = (doc: Document) => [...doc.querySelectorAll<HTMLElement>(".font-picker-option")].filter(button => !button.hidden).map(button => button.textContent);

afterEach(() => { document.body.replaceChildren(); });

describe("the HY / 휴먼 rule in the studio frame", () => {
  it("does not offer HY / 휴먼 fonts that are not installed, and keeps showing the document's own font", async () => {
    const { doc, select, openPicker } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("Noto Sans CJK KR")), { register: vi.fn() });
    await tick();
    openPicker("all", ["HY견명조", "함초롬바탕", "함초롬돋움", "맑은 고딕", "HY견고딕", "휴먼명조"]);
    await tick();
    // 맑은 고딕 is not on this PC either (the catalogue has only Noto Sans CJK KR): not offered.
    expect(offered(doc)).toEqual(["함초롬바탕", "함초롬돋움"]);
    expect(doc.querySelector(".font-picker-heading")!.textContent).toBe("모든 글꼴 (2)");
    // The caret's font is information, not an offer: it stays in 현재 글꼴 and on the control, marked.
    openPicker("current", ["HY견명조"]);
    await tick();
    expect(offered(doc)).toEqual(["HY견명조 (이 PC에 없음 → 함초롬바탕으로 보임)"]);
    expect(select.value).toBe("HY견명조");
    expect([...select.options].filter(option => !option.hidden).map(option => option.value)).toEqual(["함초롬바탕", "함초롬돋움", "HY견명조"]);
    expect(select.selectedOptions[0].textContent).toBe("HY견명조 (이 PC에 없음 → 함초롬바탕으로 보임)");
    stop();
    expect([...select.options].every(option => !option.hidden)).toBe(true);
    expect([...select.options].map(option => option.textContent)).toEqual(["함초롬바탕", "함초롬돋움", "맑은 고딕", "HY견고딕", "HY견명조"]);
  });

  it("offers an HY font that is really installed (the gateway's catalogue)", async () => {
    const { doc, openPicker } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("HY견고딕", "함초롬바탕")), { register: vi.fn() });
    await tick();
    openPicker("all", ["함초롬바탕", "HY견고딕", "HY견명조"]);
    await tick();
    expect(offered(doc)).toEqual(["함초롬바탕", "HY견고딕"]);
    stop();
  });

  it("offers a font the catalogue reports under another name (Windows / macOS: a Korean family with an English alias, or only one of them)", async () => {
    const { doc, openPicker } = studio();
    // The desktop helper's catalogue: the Korean name as the family, the English one as an alias.
    const stop = installHwpFontRule(doc, Promise.resolve({ revision: "r", faces: [face("HY견고딕", ["HYGothic-Extra", "HYGothic-Extra Regular"]), face("HYMyeongJo-Extra"), face("HY중고딕", ["HYGothic-Medium"])] }), { register: vi.fn() });
    await tick();
    // HYGothic-Medium is known only from the catalogue's alias (not from the rule's own pairs).
    openPicker("all", ["HYGothic-Extra", "HY견고딕", "HY견명조", "HY헤드라인M", "HYGothic-Medium"]);
    await tick();
    expect(offered(doc)).toEqual(["HYGothic-Extra", "HY견고딕", "HY견명조", "HYGothic-Medium"]);
    stop();
  });

  it("checks names against a lookup made once per catalogue, and only when the font list or picker changes", async () => {
    const names = Array.from({ length: 1400 }, (_, index) => `설치 글꼴 ${index}`);
    const { doc, select, openPicker } = studio();
    const lower = vi.spyOn(String.prototype, "toLocaleLowerCase");
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot(...names, "HY견고딕")), { register: vi.fn() });
    await tick();
    // One pass over the catalogue to build the lookup, then about one key per name on screen.
    openPicker("all", [...names.slice(0, 1395), "HY견고딕", "HY견명조", "HY헤드라인M", "휴먼명조", "함초롬바탕"]);
    await tick();
    expect(offered(doc)).toContain("HY견고딕");
    expect(offered(doc)).not.toContain("HY견명조");
    const opening = lower.mock.calls.length;
    expect(opening).toBeLessThan(1401 + 3 * (1400 + select.options.length));
    // The page's own redraws (layers added and removed) are not the font list: no work at all.
    lower.mockClear();
    for (let index = 0; index < 20; index++) { doc.body.append(doc.createElement("canvas")); doc.querySelector("canvas")!.remove(); await tick(); }
    doc.body.insertAdjacentHTML("beforeend", '<div id="status-bar">1 / 2 쪽</div>');
    await tick();
    expect(lower.mock.calls.length).toBe(0);
    // A change to the font list is: one pass over the names shown.
    select.add(Object.assign(doc.createElement("option"), { value: "HY중고딕", textContent: "HY중고딕" }));
    await tick();
    expect(select.options[select.options.length - 1].hidden).toBe(true);
    expect(lower.mock.calls.length).toBeLessThan(3 * (1400 + select.options.length));
    lower.mockRestore();
    stop();
  });

  it("does nothing when the catalogue cannot be read (installed fonts are not known: nothing hidden, rewritten or shadowed)", async () => {
    const { doc, select, openPicker } = studio();
    const register = vi.fn();
    const stop = installHwpFontRule(doc, Promise.reject(new Error("offline")), { register });
    await tick();
    openPicker("all", ["HY견고딕", "함초롬바탕"]);
    await tick();
    expect(offered(doc)).toEqual(["HY견고딕", "함초롬바탕"]);
    select.value = "HY견고딕";
    select.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).Event("change", { bubbles: true }));
    expect(select.value).toBe("HY견고딕");
    expect(register).not.toHaveBeenCalled();
    stop();
  });

  it("says so when it applies 함초롬 instead of the chosen font, and the control shows the font applied", async () => {
    const { doc, select } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("맑은 고딕")), { register: vi.fn() });
    await tick();
    select.add(Object.assign(doc.createElement("option"), { value: "HY견고딕", textContent: "HY견고딕" }));
    select.value = "HY견고딕";
    select.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).Event("change", { bubbles: true }));
    expect(select.value).toBe("함초롬돋움");
    const note = doc.querySelector('[role="status"]');
    expect(note?.textContent).toBe("HY견고딕은 이 PC에 없어 함초롬돋움으로 적용했습니다.");
    // A font the PC has: no note.
    select.value = "맑은 고딕";
    select.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).Event("change", { bubbles: true }));
    expect(doc.querySelector('[role="status"]')?.textContent ?? "").toBe("");
    stop();
    expect(doc.querySelector('[role="status"]')).toBeNull();
  });

  it("applies 함초롬 instead of an HY / 휴먼 font that is not installed (the document's existing text keeps its own)", async () => {
    const { doc, select } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot()), { register: vi.fn() });
    await tick();
    const applied: string[] = [];
    select.addEventListener("change", () => applied.push(select.value)); // the studio's own handler
    for (const name of ["HY견고딕", "휴먼명조", "맑은 고딕"]) {
      // As the studio's picker does: add the option if missing, set it, announce the change.
      if (![...select.options].some(option => option.value === name)) select.add(Object.assign(doc.createElement("option"), { value: name, textContent: name }));
      select.value = name;
      select.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).Event("change", { bubbles: true }));
    }
    expect(applied).toEqual(["함초롬돋움", "함초롬바탕", "맑은 고딕"]);
    stop();
  });

  it("draws 함초롬 and the Noto fallbacks with the bundled faces only where the PC has no such font", async () => {
    const register = vi.fn<(face: FaceRegistration) => void>();
    const first = studio();
    const stopA = installHwpFontRule(first.doc, Promise.resolve(snapshot("Noto Sans CJK KR")), { register });
    await tick();
    const families = (calls: typeof register.mock.calls) => calls.map(([item]) => `${item.family} ${item.weight} ${item.url}`);
    expect(families(register.mock.calls)).toEqual(HWP_FALLBACK_FACES.map(item => `${item.family} ${item.weight} ${item.url}`));
    expect(families(register.mock.calls)).toContain("함초롬바탕 700 fonts/NotoSerifKR-Bold.woff2");
    expect(families(register.mock.calls)).toContain("함초롬돋움 400 fonts/NotoSansKR-Regular.woff2");
    stopA();
    register.mockClear();
    // Installed fonts come first: 함초롬 on this PC is drawn with itself, never shadowed.
    const second = studio();
    const stopB = installHwpFontRule(second.doc, Promise.resolve(snapshot("함초롬바탕", "함초롬돋움", "Noto Serif KR")), { register });
    await tick();
    expect(register.mock.calls.map(([item]) => item.family)).toEqual(["Noto Sans KR", "Noto Sans KR"]);
    stopB();
  });
});

// The one rule, wherever the studio offers or accepts a font (H2 round 2): the style bar and its
// picker (above), 글자 모양 (Alt+L) and its language tabs — also when 스타일 opens it —, 글꼴 세트
// 편집, the font sets themselves, and 수식 속성's font name. The studio builds these lists from its
// web-font table (153 names, many a CDN this offline build cannot load) and the PC's fonts.
describe("the one font rule in every place a font can be chosen", () => {
  const WEB = ["HY견고딕", "HY견명조", "HYGothic-Extra", "카페24 슈퍼매직", "정부상징 부처명", "맑은 고딕", "함초롬돋움", "함초롬바탕", "Noto Sans KR"];
  /** 글자 모양 as the studio builds it (char-shape-dialog.ts): language select, then one font select with 웹 글꼴 / 로컬 글꼴. */
  function charShape(doc: Document, documentFont: string) {
    doc.body.insertAdjacentHTML("beforeend", `<div class="modal-overlay"><div class="dialog-wrap"><div class="dialog-body">
      <select class="dialog-select" id="zz-lang"><option value="0">대표</option><option value="1">한글</option><option value="2">영문</option></select>
      <select class="dialog-select" id="zz-font"><optgroup label="웹 글꼴">${WEB.map(name => `<option value="${name}">${name}</option>`).join("")}</optgroup>
      <optgroup label="로컬 글꼴"><option value="나눔고딕">나눔고딕</option></optgroup></select></div>
      <div class="cs-right-col"><button class="dialog-btn dialog-btn-primary">설정</button><button class="dialog-btn">취소</button></div></div></div>`);
    // The studio's own buttons: 설정 applies and closes, 취소 closes (char-shape-dialog.ts handleOk / hide).
    for (const button of doc.querySelectorAll<HTMLButtonElement>(".modal-overlay .dialog-btn")) button.addEventListener("click", () => button.closest(".modal-overlay")?.remove());
    const font = doc.getElementById("zz-font") as HTMLSelectElement;
    // updateLangFields: the document's font for the language, added when the list lacks it.
    font.value = documentFont;
    if (font.value !== documentFont) { font.add(Object.assign(doc.createElement("option"), { value: documentFont, textContent: documentFont })); font.value = documentFont; }
    return font;
  }
  const shown = (select: HTMLSelectElement) => [...select.options].filter(option => !option.hidden).map(option => option.textContent);
  const change = (target: HTMLElement) => target.dispatchEvent(new (target.ownerDocument.defaultView as Window & typeof globalThis).Event("change", { bubbles: true }));
  const pointer = (target: HTMLElement) => target.dispatchEvent(new (target.ownerDocument.defaultView as Window & typeof globalThis).Event("pointerdown", { bubbles: true }));

  it("글자 모양: offers only fonts this PC can draw, shows the document's own missing font marked, and never rewrites it", async () => {
    const { doc } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("나눔고딕", "Noto Sans CJK KR")), { register: vi.fn() });
    await tick();
    const font = charShape(doc, "HY견고딕");
    await tick();
    expect(shown(font)).toEqual(["HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)", "함초롬돋움", "함초롬바탕", "Noto Sans KR", "나눔고딕"]);
    // The closed 140 px control shows the mark first in a short form (round 3, H2-R2-4); the list keeps the full text.
    // The mark in its TEXT form (U+26A0 U+FE0E: never a colour emoji, round 4) and a spoken form for the control's name.
    expect([...font.options].filter(option => !option.hidden && option.dataset.short).map(option => `${option.value}=${option.dataset.short}`)).toEqual(["HY견고딕=\u26A0\uFE0E HY견고딕"]);
    expect([...font.options].filter(option => !option.hidden && option.dataset.spoken).map(option => option.dataset.spoken)).toEqual(["HY견고딕, 이 PC에 없음, 함초롬돋움으로 보임"]);
    // Not a pick: the document's name stays (the dialog applies only a changed value).
    expect(font.value).toBe("HY견고딕");
    // Another language tab: the studio sets the value in code; the list is put right before it opens.
    font.value = "맑은 고딕";
    pointer(font);
    // (The 대표 tab's HY견고딕 is a font of this document too: it stays pickable, marked — round 3.)
    expect(shown(font)).toEqual(["HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)", "맑은 고딕 (이 PC에 없음 → 함초롬돋움으로 보임)", "함초롬돋움", "함초롬바탕", "Noto Sans KR", "나눔고딕"]);
    expect(font.value).toBe("맑은 고딕");
    stop();
  });

  it("글자 모양: picking an HY font this PC lacks applies 함초롬 there too, with the note under that control", async () => {
    const { doc } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("나눔고딕")), { register: vi.fn() });
    await tick();
    const font = charShape(doc, "함초롬돋움");
    await tick();
    const applied: string[] = [];
    font.addEventListener("change", () => applied.push(font.value)); // the dialog's own preview handler
    font.value = "HY견명조";
    change(font);
    expect(font.value).toBe("함초롬바탕");
    expect(applied).toEqual(["함초롬바탕"]);
    // Picked in a dialog that can still be cancelled: said as what the dialog will apply, not as applied.
    expect(doc.querySelector('[role="status"]')?.textContent).toBe("HY견명조는 이 PC에 없어 함초롬바탕으로 바꿔 둡니다.");
    font.value = "나눔고딕";
    change(font);
    expect(font.value).toBe("나눔고딕");
    stop();
  });

  // H2-R2-3 (round 3): "…으로 적용했습니다" when the choice is applied (설정 / 확인), never for a dialog that was cancelled.
  it("says '…으로 적용했습니다' when 설정 applies the substituted font, and nothing when the dialog is cancelled or the pick undone", async () => {
    const { doc } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("나눔고딕")), { register: vi.fn() });
    await tick();
    const note = () => doc.querySelector<HTMLElement>('[role="status"]');
    const visible = () => (note() && !note()!.hidden ? note()!.textContent : "");
    // 설정 after picking HY견명조.
    let font = charShape(doc, "함초롬돋움");
    await tick();
    font.value = "HY견명조"; change(font);
    expect(visible()).not.toContain("적용했습니다");
    doc.querySelector<HTMLButtonElement>(".dialog-btn-primary")!.click();
    await tick(); await tick();
    expect(visible()).toBe("HY견명조는 이 PC에 없어 함초롬바탕으로 적용했습니다.");
    // 취소 after the same pick: nothing applied, nothing said.
    font = charShape(doc, "함초롬돋움");
    await tick();
    font.value = "HY견명조"; change(font);
    [...doc.querySelectorAll<HTMLButtonElement>(".dialog-btn")].find(button => button.textContent === "취소")!.click();
    await tick(); await tick();
    expect(visible()).toBe("");
    // Picked, then another font the PC has picked in its place, then 설정: no substitution to speak of.
    font = charShape(doc, "함초롬돋움");
    await tick();
    font.value = "HY견명조"; change(font);
    font.value = "나눔고딕"; change(font);
    doc.querySelector<HTMLButtonElement>(".dialog-btn-primary")!.click();
    await tick(); await tick();
    expect(visible()).toBe("");
    stop();
  });

  it("the note goes with its dialog: closed or cancelled, nothing was applied, so it is not left over the page", async () => {
    const { doc } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("나눔고딕")), { register: vi.fn() });
    await tick();
    const font = charShape(doc, "함초롬돋움");
    await tick();
    font.value = "HY견명조";
    change(font);
    const note = () => doc.querySelector<HTMLElement>('[role="status"]');
    expect(note()?.hidden).toBe(false);
    // 취소: the studio removes its dialog.
    doc.querySelector(".modal-overlay")!.remove();
    await tick();
    expect(note()?.hidden ?? true).toBe(true);
    // A note said under the style bar's own control stays (that control is still there).
    const bar = doc.getElementById("font-name") as HTMLSelectElement;
    bar.value = "HY견고딕"; change(bar);
    doc.body.append(doc.createElement("div"));
    await tick();
    expect(note()?.hidden).toBe(false);
    stop();
  });

  it("글꼴 세트 편집: its seven language lists follow the same rule (no web-font names, no generic families)", async () => {
    const { doc } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("나눔고딕")), { register: vi.fn() });
    await tick();
    doc.body.insertAdjacentHTML("beforeend", `<div class="dialog-wrap"><select class="dialog-select fse-select"><optgroup label="웹 글꼴">
      ${[...WEB, "sans-serif", "serif"].map(name => `<option value="${name}">${name}</option>`).join("")}</optgroup>
      <optgroup label="로컬 글꼴"><option value="나눔고딕">나눔고딕</option></optgroup></select></div>`);
    const select = doc.querySelector<HTMLSelectElement>(".fse-select")!;
    select.value = "함초롬바탕";
    await tick();
    expect(shown(select)).toEqual(["함초롬돋움", "함초롬바탕", "Noto Sans KR", "나눔고딕"]);
    stop();
  });

  it("font sets: offered only when the PC can draw every font in them (the style bar and the picker's 대표 글꼴)", async () => {
    const { doc, select, openPicker } = studio();
    doc.defaultView!.localStorage.setItem("rhwp-settings", JSON.stringify({ font: { fontSets: [
      { name: "보고서", korean: "HY헤드라인M", english: "함초롬돋움", chinese: "함초롬돋움", japanese: "함초롬돋움", other: "함초롬돋움", symbol: "함초롬돋움", user: "함초롬돋움" },
      { name: "본문", korean: "나눔고딕", english: "나눔고딕", chinese: "나눔고딕", japanese: "나눔고딕", other: "나눔고딕", symbol: "나눔고딕", user: "나눔고딕" }] } }));
    const group = doc.createElement("optgroup"); group.label = "대표 글꼴";
    for (const name of ["함초롬", "맑은 고딕", "바탕", "보고서", "본문"]) group.append(Object.assign(doc.createElement("option"), { value: `__fontset__${name}`, textContent: `◆ ${name}` }));
    select.prepend(group);
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("나눔고딕")), { register: vi.fn() });
    await tick();
    expect([...group.children].filter(option => !(option as HTMLOptionElement).hidden).map(option => option.textContent)).toEqual(["◆ 함초롬", "◆ 본문"]);
    doc.body.insertAdjacentHTML("beforeend", `<div class="font-picker-menu" role="dialog"><div class="font-picker-categories">
      <button class="font-picker-category active" data-category="fontSets">대표 글꼴</button></div>
      <div><div class="font-picker-heading" data-role="heading">대표 글꼴 (5)</div><div data-role="list">
      ${["함초롬", "맑은 고딕", "바탕", "보고서", "본문"].map(name => `<button class="font-picker-option" role="option">◆ ${name}</button>`).join("")}</div></div></div>`);
    await tick();
    expect(offered(doc)).toEqual(["◆ 함초롬", "◆ 본문"]);
    expect(doc.querySelector(".font-picker-heading")!.textContent).toBe("대표 글꼴 (2)");
    void openPicker;
    stop();
  });

  it("the picker's 문서 글꼴 shows the document's fonts this PC lacks, marked; 모든 글꼴 does not offer them", async () => {
    const { doc, openPicker } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("나눔고딕")), { register: vi.fn() });
    await tick();
    openPicker("all", ["HY견고딕", "맑은 고딕", "함초롬돋움", "나눔고딕"]);
    await tick();
    expect(offered(doc)).toEqual(["함초롬돋움", "나눔고딕"]);
    doc.querySelector(".font-picker-menu")!.remove();
    doc.body.insertAdjacentHTML("beforeend", `<div class="font-picker-menu" role="dialog"><div class="font-picker-categories">
      <button class="font-picker-category active" data-category="document">문서 글꼴</button></div>
      <div><div class="font-picker-heading" data-role="heading">문서 글꼴 (3)</div><div data-role="list">
      ${["HY견고딕", "함초롬바탕", "맑은 고딕"].map(name => `<button class="font-picker-option" role="option">${name}</button>`).join("")}</div></div></div>`);
    await tick();
    expect(offered(doc)).toEqual(["HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)", "함초롬바탕", "맑은 고딕 (이 PC에 없음 → 함초롬돋움으로 보임)"]);
    stop();
  });

  // H2-R2-1 (round 3): Hancom keeps the current font pickable — so does this list, for the dialog's lifetime.
  it("글자 모양: the document's own font stays in the list after another font was picked, and picking it back restores its name", async () => {
    const { doc } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("나눔고딕")), { register: vi.fn() });
    await tick();
    const font = charShape(doc, "휴먼명조");
    await tick();
    const applied: string[] = [];
    font.addEventListener("change", () => applied.push(font.value)); // the dialog's own handler
    const own = "휴먼명조 (이 PC에 없음 → 함초롬바탕으로 보임)";
    expect(shown(font)).toContain(own);
    font.value = "함초롬돋움"; change(font);
    await tick();
    pointer(font);
    expect(shown(font)).toEqual(["함초롬돋움", "함초롬바탕", "Noto Sans KR", "나눔고딕", own]);
    font.value = "휴먼명조"; change(font);
    expect(font.value).toBe("휴먼명조");
    expect(applied).toEqual(["함초롬돋움", "휴먼명조"]);
    expect(doc.querySelector<HTMLElement>('[role="status"]')?.hidden ?? true).toBe(true);
    stop();
  });

  // H2-R2-2 (round 3): choosing the font the document already has is a no-op on text that uses it;
  // the document's name is never replaced by the substitute because the person clicked it.
  it("the style bar's 문서 글꼴: choosing the document's own (marked) font changes nothing on text that has it, and applies the name itself elsewhere", async () => {
    const { doc, select } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot("나눔고딕")), { register: vi.fn() });
    await tick();
    const applied: string[] = [];
    select.addEventListener("change", () => applied.push(select.value)); // the studio's own handler (format-char)
    const documentFonts = (names: string[]) => {
      doc.querySelector(".font-picker-menu")?.remove();
      doc.body.insertAdjacentHTML("beforeend", `<div class="font-picker-menu" role="dialog"><div class="font-picker-categories">
        <button class="font-picker-category active" data-category="document">문서 글꼴</button></div>
        <div><div class="font-picker-heading" data-role="heading">문서 글꼴 (${names.length})</div><div data-role="list">
        ${names.map(name => `<button class="font-picker-option" role="option">${name}</button>`).join("")}</div></div></div>`);
    };
    // As the studio's picker (toolbar.ts selectFontMenuEntry): set the value, announce a change — also for the same value.
    const pick = (name: string) => { select.value = name; change(select); };
    // The caret is in text set in HY견명조 (the studio set the value in code); the picker opens.
    pointer(select);
    documentFonts(["HY견명조", "함초롬바탕"]);
    await tick();
    pick("HY견명조");
    expect(applied).toEqual([]);
    expect(select.value).toBe("HY견명조");
    expect(doc.querySelector<HTMLElement>('[role="status"]')?.hidden ?? true).toBe(true);
    // The caret moves into 함초롬바탕 text (set in code); the picker opens again; the document's HY견명조 is chosen:
    // applied as HY견명조 itself, the name the document has — not rewritten to 함초롬바탕.
    select.value = "함초롬바탕";
    pointer(select);
    documentFonts(["HY견명조", "함초롬바탕"]);
    await tick();
    pick("HY견명조");
    expect(applied).toEqual(["HY견명조"]);
    expect(doc.querySelector<HTMLElement>('[role="status"]')?.hidden ?? true).toBe(true);
    // A missing HY font the document does NOT have is still applied as 함초롬, as before.
    select.add(Object.assign(doc.createElement("option"), { value: "HY견고딕", textContent: "HY견고딕" }));
    pick("HY견고딕");
    expect(applied).toEqual(["HY견명조", "함초롬돋움"]);
    stop();
  });

  it("수식 속성's font name (typed): an HY font this PC lacks is applied as 함초롬, with the note", async () => {
    const { doc } = studio();
    const stop = installHwpFontRule(doc, Promise.resolve(snapshot()), { register: vi.fn() });
    await tick();
    doc.body.insertAdjacentHTML("beforeend", `<div class="modal-overlay"><div class="dialog-wrap eq-props-dialog"><div class="dialog-row eq-props-row"><span class="dialog-label">글꼴</span><input type="text" class="dialog-input"></div>
      <div class="dialog-row eq-props-row"><span class="dialog-label">설명</span><input type="text" class="dialog-input"></div><button class="dialog-btn dialog-btn-primary">확인</button></div></div>`);
    const [name, other] = [...doc.querySelectorAll<HTMLInputElement>(".eq-props-dialog input")];
    name.value = "HY견고딕"; change(name);
    expect(name.value).toBe("함초롬돋움");
    expect(doc.querySelector('[role="status"]')?.textContent).toBe("HY견고딕은 이 PC에 없어 함초롬돋움으로 바꿔 둡니다.");
    name.value = "HancomEQN"; change(name);
    expect(name.value).toBe("HancomEQN");
    other.value = "HY견고딕"; change(other);
    expect(other.value).toBe("HY견고딕");
    // 확인 applies it: said then.
    name.value = "HY견고딕"; change(name);
    const ok = doc.querySelector<HTMLButtonElement>(".eq-props-dialog .dialog-btn-primary")!;
    ok.addEventListener("click", () => ok.closest(".modal-overlay")!.remove());
    ok.click();
    await tick(); await tick();
    expect(doc.querySelector('[role="status"]')?.textContent).toBe("HY견고딕은 이 PC에 없어 함초롬돋움으로 적용했습니다.");
    stop();
  });
});
