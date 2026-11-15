// @vitest-environment jsdom
// HOP's drawn drop-down in the embedded studio frame (MIT; third_party/hop/LICENSE).
import { afterEach, describe, expect, it } from "vitest";
import { enhanceCustomSelects } from "../../../third_party/hop/custom-select.ts";

/** The studio is another document (its own iframe realm), as in the app. */
function studio(html: string) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = html;
  return doc;
}
const STYLE_BAR = `<div id="style-bar"><select id="font-name" class="sb-combo sb-font" title="글꼴">
  <option value="함초롬바탕">함초롬바탕</option><option value="함초롬돋움">함초롬돋움</option><option value="맑은 고딕" disabled>맑은 고딕</option><option value="바탕">바탕</option>
</select></div>`;
const key = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new (target.ownerDocument.defaultView as Window & typeof globalThis).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const press = (target: Element) =>
  target.dispatchEvent(new (target.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

/** What the closed control shows. */
const shown = (doc: Document) => doc.querySelector(".custom-select-value")!.textContent;
afterEach(() => { document.body.replaceChildren(); });

describe("custom select in the HWP studio", () => {
  it("draws the style-bar select as one labelled combobox and keeps the original select as the state holder", () => {
    const doc = studio(STYLE_BAR);
    const stop = enhanceCustomSelects(doc);
    const select = doc.getElementById("font-name") as HTMLSelectElement;
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!;
    expect(select.isConnected).toBe(true);
    expect(select.tabIndex).toBe(-1);
    expect(select.getAttribute("aria-hidden")).toBe("true");
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBe("글꼴");
    expect(shown(doc)).toBe("함초롬바탕");
    // One tab stop: the wrapper is not focusable on its own.
    expect(doc.querySelectorAll('[tabindex="0"]').length).toBe(0);
    stop();
  });

  it("is operable from the keyboard: open, move, choose, and Escape leaves the value", () => {
    const doc = studio(STYLE_BAR);
    const stop = enhanceCustomSelects(doc);
    const select = doc.getElementById("font-name") as HTMLSelectElement;
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!;
    const changes: string[] = [];
    select.addEventListener("change", () => changes.push(select.value));
    trigger.focus();
    key(trigger, "ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const listbox = doc.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(listbox.getAttribute("role")).toBe("listbox");
    const active = () => doc.getElementById(trigger.getAttribute("aria-activedescendant")!);
    expect(active()?.textContent).toBe("함초롬바탕");
    expect(active()?.getAttribute("aria-selected")).toBe("true");
    key(trigger, "ArrowDown");
    key(trigger, "ArrowDown"); // skips the disabled 맑은 고딕
    expect(active()?.textContent).toBe("바탕");
    // Moving does not apply a font yet.
    expect(changes).toEqual([]);
    key(trigger, "Enter");
    expect(select.value).toBe("바탕");
    expect(changes).toEqual(["바탕"]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement).toBe(trigger);
    key(trigger, " ");
    key(trigger, "Home");
    key(trigger, "Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(select.value).toBe("바탕");
    expect(changes).toEqual(["바탕"]);
    stop();
  });

  it("opens with the mouse, commits a row, and closes on an outside press", () => {
    const doc = studio(STYLE_BAR);
    const stop = enhanceCustomSelects(doc);
    const select = doc.getElementById("font-name") as HTMLSelectElement;
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!;
    press(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const row = [...doc.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === "함초롬돋움")!;
    press(row);
    expect(select.value).toBe("함초롬돋움");
    expect(shown(doc)).toBe("함초롬돋움");
    press(trigger);
    press(doc.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    stop();
  });

  it("opens upward in the viewport when the space below is short, so a dialog's edge cannot cut it off", () => {
    const doc = studio('<div class="dialog-wrap"><div class="dialog-body" style="overflow:hidden"><label for="scope">적용 범위</label><select id="scope" class="dialog-select"><option>문서 전체</option><option>현재 구역</option><option>새 구역으로</option></select></div></div>');
    const view = doc.defaultView!;
    Object.defineProperty(view, "innerHeight", { configurable: true, value: 600 });
    Object.defineProperty(view, "innerWidth", { configurable: true, value: 800 });
    const stop = enhanceCustomSelects(doc);
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!, menu = doc.querySelector<HTMLElement>(".custom-select-menu")!;
    Object.defineProperty(menu, "scrollHeight", { configurable: true, value: 96 });
    // A list with no width of its own is as wide as its containing block (here, the viewport) until its minimum is set.
    Object.defineProperty(menu, "offsetWidth", { configurable: true, get: () => menu.style.minWidth ? 120 : 800 });
    // Near the bottom: 40 px below the control, 520 above.
    trigger.getBoundingClientRect = () => ({ top: 532, bottom: 560, left: 300, right: 420, width: 120, height: 28, x: 300, y: 532, toJSON() {} }) as DOMRect;
    press(trigger);
    expect(menu.style.position).toBe("fixed");
    // Upward: its bottom 4 px above the control.
    expect([menu.style.top, menu.style.left]).toEqual(["432px", "300px"]);
    press(trigger);
    // Room below: it opens downward, under the control.
    trigger.getBoundingClientRect = () => ({ top: 100, bottom: 128, left: 300, right: 420, width: 120, height: 28, x: 300, y: 100, toJSON() {} }) as DOMRect;
    press(trigger);
    expect(menu.style.top).toBe("132px");
    // A studio dialog is the containing block of a fixed list (as measured in WebKit): placed relative to it.
    press(trigger);
    menu.getBoundingClientRect = () => ({ left: menu.style.left === "0px" ? 312 : 0, top: menu.style.top === "0px" ? 20 : 0 }) as DOMRect;
    press(trigger);
    expect([menu.style.left, menu.style.top]).toEqual(["-12px", "112px"]);
    // Placed in the viewport, it would drift on scroll or resize: both close it (scrolling the list itself does not).
    menu.dispatchEvent(new view.Event("scroll"));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    doc.dispatchEvent(new view.Event("scroll"));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    press(trigger);
    view.dispatchEvent(new view.Event("resize"));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    stop();
  });

  it("opens upward where the dialog it sits in would cut it off, even with room below in the viewport", () => {
    // As in WebKitGTK at 640 px: the studio dialog is the list's containing block and clips it.
    const doc = studio('<div class="dialog-wrap" style="transform: translate(0px, 0px); overflow: hidden"><div class="dialog-body"><label for="scope">적용 범위</label><select id="scope" class="dialog-select"><option>문서 전체</option><option>새 구역으로</option></select></div></div>');
    const view = doc.defaultView!;
    Object.defineProperty(view, "innerHeight", { configurable: true, value: 600 });
    Object.defineProperty(view, "innerWidth", { configurable: true, value: 800 });
    const stop = enhanceCustomSelects(doc);
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!, menu = doc.querySelector<HTMLElement>(".custom-select-menu")!;
    Object.defineProperty(menu, "scrollHeight", { configurable: true, value: 66 });
    doc.querySelector<HTMLElement>(".dialog-wrap")!.getBoundingClientRect = () => ({ top: 20, bottom: 448, left: 231, right: 671, width: 440, height: 428, x: 231, y: 20, toJSON() {} }) as DOMRect;
    trigger.getBoundingClientRect = () => ({ top: 360, bottom: 388, left: 312, right: 404, width: 92, height: 28, x: 312, y: 360, toJSON() {} }) as DOMRect;
    press(trigger);
    // 48 px below inside the dialog is less than the list: above the control (360 - 4 - 66).
    expect(menu.style.top).toBe("290px");
    stop();
  });

  it("stays inside the dialog it sits in sideways too: a wide list (a long marked font name) starts further left", () => {
    const doc = studio('<div class="dialog-wrap" style="transform: translate(0px, 0px); overflow: hidden"><div class="dialog-body"><label for="font">글꼴</label><select id="font" class="dialog-select"><option>HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)</option><option>함초롬돋움</option></select></div></div>');
    const view = doc.defaultView!;
    Object.defineProperty(view, "innerHeight", { configurable: true, value: 900 });
    Object.defineProperty(view, "innerWidth", { configurable: true, value: 1440 });
    const stop = enhanceCustomSelects(doc);
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!, menu = doc.querySelector<HTMLElement>(".custom-select-menu")!;
    Object.defineProperty(menu, "scrollHeight", { configurable: true, value: 66 });
    Object.defineProperty(menu, "offsetWidth", { configurable: true, value: 294 });
    doc.querySelector<HTMLElement>(".dialog-wrap")!.getBoundingClientRect = () => ({ top: 20, bottom: 600, left: 451, right: 971, width: 520, height: 580, x: 451, y: 20, toJSON() {} }) as DOMRect;
    trigger.getBoundingClientRect = () => ({ top: 200, bottom: 228, left: 689, right: 829, width: 140, height: 28, x: 689, y: 200, toJSON() {} }) as DOMRect;
    press(trigger);
    // 971 - 294 - 8: the list's right edge stays 8 px inside the dialog that would cut it off.
    expect(menu.style.left).toBe("669px");
    expect(menu.style.top).toBe("232px");
    stop();
  });

  it("jumps to a row by typing its first characters", () => {
    const doc = studio('<div id="style-bar"><select id="linespacing-select" class="sb-ls-select" title="줄 간격"><option>100 %</option><option>160 %</option><option>180 %</option><option>200 %</option><option>250 %</option></select></div>');
    const stop = enhanceCustomSelects(doc);
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!;
    const active = () => doc.getElementById(trigger.getAttribute("aria-activedescendant")!)?.textContent;
    key(trigger, "ArrowDown");
    key(trigger, "2");
    expect(active()).toBe("200 %");
    key(trigger, "5");
    expect(active()).toBe("250 %");
    stop();
  });

  it("follows values the studio sets in code and options it adds later", async () => {
    const doc = studio(STYLE_BAR);
    const stop = enhanceCustomSelects(doc);
    const select = doc.getElementById("font-name") as HTMLSelectElement;
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!;
    select.value = "바탕"; // the studio moves the caret into 바탕 text
    expect(shown(doc)).toBe("바탕");
    select.selectedIndex = 1;
    expect(shown(doc)).toBe("함초롬돋움");
    const option = doc.createElement("option"); option.value = option.textContent = "나눔고딕";
    select.append(option);
    await new Promise(resolve => setTimeout(resolve, 0));
    press(trigger);
    expect([...doc.querySelectorAll('[role="option"]')].map(item => item.textContent)).toContain("나눔고딕");
    stop();
  });

  it("enhances a dialog's select when the dialog is built later, and leaves list boxes native", async () => {
    const doc = studio("<div></div>");
    const stop = enhanceCustomSelects(doc);
    doc.body.insertAdjacentHTML("beforeend", '<div class="dialog-wrap"><label for="paper">용지 종류</label><select id="paper" class="dialog-select"><option>A4</option><option>B5</option></select><select class="dialog-select" size="4"><option>1</option></select></div>');
    await new Promise(resolve => setTimeout(resolve, 0));
    const triggers = doc.querySelectorAll<HTMLElement>(".dialog-wrap .custom-select-trigger");
    expect(triggers.length).toBe(1);
    expect(triggers[0].getAttribute("aria-label")).toBe("용지 종류");
    stop();
    // Removing restores the original control.
    expect(doc.querySelector(".custom-select")).toBeNull();
    expect((doc.getElementById("paper") as HTMLSelectElement).tabIndex).toBe(0);
  });

  it("hands the font name control to the studio's own categorised font picker (with the installed fonts)", async () => {
    const doc = studio(STYLE_BAR);
    const select = doc.getElementById("font-name") as HTMLSelectElement;
    // The studio: a press on its select toggles its picker; a press elsewhere closes it (capture).
    let opened = 0;
    const setOpen = (open: boolean) => select.setAttribute("aria-expanded", String(open));
    setOpen(false);
    const keys: string[] = [];
    const stop = enhanceCustomSelects(doc, { ownPicker: "#font-name" });
    select.addEventListener("pointerdown", () => { opened++; setOpen(select.getAttribute("aria-expanded") !== "true"); });
    select.addEventListener("keydown", event => keys.push((event as KeyboardEvent).key));
    doc.addEventListener("pointerdown", event => { if (!select.contains(event.target as Node)) setOpen(false); }, true);
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!;
    const pointer = (target: Element) => {
      const View = target.ownerDocument.defaultView as Window & typeof globalThis;
      target.dispatchEvent(new View.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      target.dispatchEvent(new View.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    };
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(doc.querySelector('[role="listbox"]')).toBeNull();
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    pointer(trigger);
    await tick();
    expect(opened).toBe(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // A second press closes it (the studio's own outside press) and does not open it again.
    pointer(trigger);
    await tick();
    expect(opened).toBe(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    key(trigger, "ArrowDown");
    expect(keys).toEqual(["ArrowDown"]);
    stop();
  });

  it("leaves out the options the page hides (the font rule's names this PC cannot draw), also when hidden after it was built", () => {
    const doc = studio(`<div class="dialog-wrap"><select class="dialog-select">
      <optgroup label="웹 글꼴"><option value="함초롬돋움">함초롬돋움</option><option value="카페24 슈퍼매직" hidden>카페24 슈퍼매직</option></optgroup>
      <optgroup label="로컬 글꼴"><option value="HY견고딕" hidden>HY견고딕</option></optgroup></select></div>`);
    const stop = enhanceCustomSelects(doc);
    const select = doc.querySelector("select")!;
    const trigger = doc.querySelector<HTMLElement>(".custom-select-trigger")!;
    const listed = () => [...doc.querySelectorAll(".custom-select-menu > *")].map(row => row.textContent);
    key(trigger, "ArrowDown");
    expect(listed()).toEqual(["웹 글꼴", "함초롬돋움"]);
    key(trigger, "Escape");
    // Hidden by the page just before the list opens (no other change to the select).
    select.options[0].hidden = true;
    select.options[2].hidden = false;
    key(trigger, "ArrowDown");
    expect(listed()).toEqual(["로컬 글꼴", "HY견고딕"]);
    stop();
  });

  it("keeps the width the page gives the select (글자 모양's 140 px font list), and options it hides do not widen it", () => {
    // A long marked name ("… (이 PC에 없음 → 함초롬돋움으로 보임)") or a hidden web-font name must not
    // stretch the control past its row: in WebKitGTK the dialog body then scrolls and cuts the open list off.
    const doc = studio(`<div class="dialog-wrap"><select class="dialog-select" style="width: 140px">
      <optgroup label="웹 글꼴"><option value="함초롬돋움">함초롬돋움</option><option value="정부상징 부처명_16040911" hidden>정부상징 부처명_16040911</option>
      <option value="HY견고딕">HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)</option></optgroup></select>
      <select class="dialog-select" id="free"><option>가</option></select></div>`);
    const stop = enhanceCustomSelects(doc);
    const [fixed, free] = [...doc.querySelectorAll<HTMLElement>(".custom-select")];
    expect(fixed.style.width).toBe("140px");
    expect(free.style.width).toBe("");
    const sized = () => [...fixed.querySelectorAll(".custom-select-sizer > span")].map(line => line.textContent);
    expect(sized()).toEqual(["함초롬돋움", "HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)"]);
    // Hidden after it was built: left out of the width when the list opens.
    doc.querySelector("select")!.options[0].hidden = true;
    key(fixed.querySelector(".custom-select-trigger")!, "ArrowDown");
    expect(sized()).toEqual(["HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)"]);
    stop();
  });

  // H2-R2-4 (round 3): a marked name is longer than the 140 px control; the control shows the
  // option's short form (the mark first), the full text as its title; the open list keeps the full text.
  it("shows an option's short form in the closed control, with the full text as its title; the list keeps the full text", async () => {
    const doc = studio(`<div class="dialog-wrap"><select class="dialog-select" style="width: 140px">
      <option value="함초롬돋움">함초롬돋움</option>
      <option value="HY견고딕" data-short="⚠ HY견고딕">HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)</option></select></div>`);
    const select = doc.querySelector("select")!;
    select.value = "HY견고딕";
    const stop = enhanceCustomSelects(doc);
    const value = doc.querySelector<HTMLElement>(".custom-select-value")!;
    expect(value.textContent).toBe("⚠ HY견고딕");
    expect(value.title).toBe("HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)");
    key(doc.querySelector(".custom-select-trigger")!, "ArrowDown");
    expect([...doc.querySelectorAll(".custom-select-option")].map(row => row.textContent)).toEqual(["함초롬돋움", "HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)"]);
    key(doc.querySelector(".custom-select-trigger")!, "Escape");
    // The short form given after the control was drawn (the font rule marks names once the catalogue arrives).
    select.options[1].removeAttribute("data-short");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(value.textContent).toBe("HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)");
    select.options[1].setAttribute("data-short", "⚠ HY견고딕");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(value.textContent).toBe("⚠ HY견고딕");
    select.value = "함초롬돋움";
    expect(value.textContent).toBe("함초롬돋움");
    expect(value.title).toBe("함초롬돋움");
    stop();
  });

  // Round 4 (re-review 3, H7-R3-3): the short visible form is not all a screen reader hears — the
  // control's accessible name says the whole thing (data-spoken), after the list's own label if any.
  it("names the control with the whole meaning while a short form is shown, and only its label otherwise", async () => {
    const doc = studio(`<div class="dialog-wrap"><select class="dialog-select" style="width: 140px">
      <option value="함초롬돋움">함초롬돋움</option>
      <option value="HY견고딕" data-short="\u26A0\uFE0E HY견고딕" data-spoken="HY견고딕, 이 PC에 없음, 함초롬돋움으로 보임">HY견고딕 (이 PC에 없음 → 함초롬돋움으로 보임)</option></select>
      <select class="sb-combo" aria-label="글꼴"><option value="함초롬바탕">함초롬바탕</option>
      <option value="휴먼명조" data-short="\u26A0\uFE0E 휴먼명조" data-spoken="휴먼명조, 이 PC에 없음, 함초롬바탕으로 보임">휴먼명조 (이 PC에 없음 → 함초롬바탕으로 보임)</option></select></div>`);
    const [plain, labelled] = [...doc.querySelectorAll("select")];
    plain.value = "HY견고딕"; labelled.value = "휴먼명조";
    const stop = enhanceCustomSelects(doc);
    const [first, second] = [...doc.querySelectorAll<HTMLElement>(".custom-select-trigger")];
    expect(first.getAttribute("aria-label")).toBe("HY견고딕, 이 PC에 없음, 함초롬돋움으로 보임");
    expect(second.getAttribute("aria-label")).toBe("글꼴, 휴먼명조, 이 PC에 없음, 함초롬바탕으로 보임");
    // The visible short form is unchanged.
    expect(first.querySelector(".custom-select-value")!.textContent).toBe("\u26A0\uFE0E HY견고딕");
    plain.value = "함초롬돋움"; labelled.value = "함초롬바탕";
    plain.dispatchEvent(new Event("change")); labelled.dispatchEvent(new Event("change"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(first.hasAttribute("aria-label")).toBe(false);
    expect(second.getAttribute("aria-label")).toBe("글꼴");
    stop();
  });
});
