// From Achmage HOP @ d533eb4360db034cd45d87b0751c0d742c6d6ca6 (apps/studio-host/src/ui/custom-select.ts). MIT; see LICENSE.
// Adapted for the Workbench studio frame: runs on the studio's own document (another realm), one
// focus stop announced as a combobox, list navigation that applies only on Enter (the original
// stepped the value, applying a font per arrow press), follows values the studio sets in code and
// selects it builds later (dialogs), leaves out hidden options, shows an option's short form
// (data-short) in the closed control, named with its whole meaning (data-spoken), and can be removed.
/**
 * Native select popups differ by OS (WebKitGTK and WKWebView draw rough ones), so the studio's
 * selects stay as state holders and this layer draws the visible control and its list.
 */

const SELECT_SELECTOR = ["select.sb-combo", "select.sb-ls-select", "select.dialog-select", "select.formula-select"].join(",");

type Enhanced = { root: HTMLElement; sync: () => void; close: () => void; restore: () => void };
const enhanced = new WeakMap<HTMLSelectElement, Enhanced>();
let nextId = 0;

/**
 * Enhances the studio's selects now and as they are built; returns the removal. `ownPicker`: selects
 * that open a picker of the studio's own (its categorised font menu); the drawn control hands
 * presses and keys to it instead of drawing a list.
 */
export function enhanceCustomSelects(doc: Document, options: { ownPicker?: string } = {}): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const owned = new Set<HTMLSelectElement>();
  const scan = () => {
    for (const select of doc.querySelectorAll<HTMLSelectElement>(SELECT_SELECTOR)) if (!enhanced.has(select) && enhance(select, view, Boolean(options.ownPicker && select.matches(options.ownPicker)))) owned.add(select);
  };
  scan();
  let queued = false;
  const observer = new view.MutationObserver(records => {
    if (queued || !records.some(record => Array.from(record.addedNodes).some(node => node.nodeType === 1))) return;
    queued = true;
    queueMicrotask(() => { queued = false; scan(); });
  });
  observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
  // Capture: studio handlers that stop a press must not keep a list open.
  const outside = (event: Event) => {
    for (const select of owned) { const item = enhanced.get(select); if (item && !item.root.contains(event.target as Node)) item.close(); }
  };
  doc.addEventListener("mousedown", outside, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener("mousedown", outside, true);
    for (const select of owned) enhanced.get(select)?.restore();
    owned.clear();
  };
}

function enhance(select: HTMLSelectElement, view: Window & typeof globalThis, ownPicker: boolean): boolean {
  if (select.multiple || select.size > 1 || select.dataset.nativeSelect === "true") return false;
  const doc = select.ownerDocument, id = `wb-custom-select-${++nextId}`;
  const root = doc.createElement("div");
  root.className = `custom-select ${select.className}`.trim();
  root.dataset.selectId = select.id || "";
  // A width the page gives the select (글자 모양's font list: 140 px) is the control's, as for a native select.
  if (select.style.width) root.style.width = select.style.width;
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (!ownPicker) trigger.setAttribute("aria-controls", `${id}-list`);
  const label = select.getAttribute("aria-label") || select.title || (select.labels?.[0]?.textContent ?? "").trim();
  if (label) trigger.setAttribute("aria-label", label);
  if (select.title) trigger.title = select.title;
  const text = doc.createElement("span"); text.className = "custom-select-text";
  const value = doc.createElement("span"); value.className = "custom-select-value";
  // Every label, laid out at zero height: the control is as wide as its widest option, as a native select is.
  const sizer = doc.createElement("span"); sizer.className = "custom-select-sizer"; sizer.setAttribute("aria-hidden", "true");
  text.append(value, sizer);
  const arrow = doc.createElement("span"); arrow.className = "custom-select-arrow"; arrow.textContent = "▾"; arrow.setAttribute("aria-hidden", "true");
  const menu = doc.createElement("div");
  menu.className = "custom-select-menu"; menu.id = `${id}-list`; menu.setAttribute("role", "listbox");
  if (label) menu.setAttribute("aria-label", label);
  trigger.append(text, arrow);
  const place = { parent: select.parentNode, next: select.nextSibling };
  select.before(root);
  root.append(...(ownPicker ? [trigger, select] : [trigger, menu, select]));
  const previous = { tabIndex: select.getAttribute("tabindex"), hidden: select.getAttribute("aria-hidden") };
  // An own picker places itself under the select's box: the hidden select covers the control.
  const hiddenClass = ownPicker ? "native-select-anchor" : "native-select-hidden";
  select.classList.add(hiddenClass);
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  let active = -1;
  const rows = () => Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]'));
  const enabled = (row: HTMLElement) => row.getAttribute("aria-disabled") !== "true";
  const setActive = (index: number) => {
    const list = rows();
    active = index;
    list.forEach((row, at) => row.classList.toggle("active", at === index));
    const row = list[index];
    if (row) { trigger.setAttribute("aria-activedescendant", row.id); row.scrollIntoView?.({ block: "nearest" }); }
    else trigger.removeAttribute("aria-activedescendant");
  };
  const isOpen = () => root.classList.contains("open");
  // Placed fixed, so no dialog body (overflow: hidden) cuts it off; upward when below is short.
  // A studio dialog (transformed) is the containing block of a fixed list and, with overflow hidden, clips it.
  const clipBox = () => {
    for (let node = root.parentElement; node && node !== doc.documentElement; node = node.parentElement) {
      const style = view.getComputedStyle(node);
      if ((style.transform && style.transform !== "none") || (style.filter && style.filter !== "none") || /paint|layout|strict|content/.test(style.contain || "")) {
        return style.overflow && style.overflow !== "visible" ? node.getBoundingClientRect() : null;
      }
    }
    return null;
  };
  const position = () => {
    const box = trigger.getBoundingClientRect(), gap = 4, edge = 8, cap = 280, clip = clipBox();
    const floor = Math.min(view.innerHeight, clip?.bottom ?? Infinity), ceiling = Math.max(0, clip?.top ?? 0);
    const below = floor - box.bottom - gap - edge, above = box.top - ceiling - gap - edge;
    const up = below < Math.min(menu.scrollHeight, cap) && above > below;
    const room = Math.max(0, Math.min(cap, up ? above : below));
    // Width first: it decides how far left the list must start to stay inside the viewport.
    menu.style.minWidth = `${box.width}px`;
    Object.assign(menu.style, { position: "fixed", left: "0px", top: "0px", maxHeight: `${room}px` });
    // A studio dialog is the containing block of a fixed list: measure where its origin is.
    const origin = menu.getBoundingClientRect();
    // Sideways too: inside the viewport and inside the dialog that would cut it off.
    const right = Math.min(view.innerWidth, clip?.right ?? Infinity), leftmost = Math.max(0, clip?.left ?? 0);
    const left = Math.max(leftmost + edge, Math.min(box.left, right - menu.offsetWidth - edge));
    const top = up ? box.top - gap - Math.min(menu.scrollHeight, room) : box.bottom + gap;
    Object.assign(menu.style, { left: `${left - origin.left}px`, top: `${top - origin.top}px` });
  };
  const drift = (event: Event) => { if (event.target !== menu) close(); };
  const close = () => {
    if (ownPicker || !isOpen()) return;
    doc.removeEventListener("scroll", drift, true);
    view.removeEventListener("resize", close);
    root.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
  };
  const open = () => {
    if (select.disabled || isOpen()) return;
    // Built afresh: the page may have hidden or shown options just before (the font rule).
    rebuild();
    sync();
    root.classList.add("open");
    position();
    doc.addEventListener("scroll", drift, true);
    view.addEventListener("resize", close);
    trigger.setAttribute("aria-expanded", "true");
    setActive(Math.max(0, rows().findIndex(row => row.getAttribute("aria-selected") === "true")));
  };
  const commit = (option: HTMLOptionElement) => {
    if (option.disabled) return;
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new view.Event("change", { bubbles: true }));
    }
    sync();
    close();
    trigger.focus();
  };
  // Type-ahead: the next row whose label starts with what was typed in the last half second.
  let typed = "", typedAt = 0;
  const seek = (char: string) => {
    const now = Date.now(); typed = (now - typedAt < 500 ? typed : "") + char.toLocaleLowerCase(); typedAt = now;
    const list = rows();
    for (let step = typed.length > 1 ? 0 : 1; step <= list.length; step++) {
      const at = (Math.max(active, 0) + step) % list.length;
      if (enabled(list[at]) && (list[at].textContent ?? "").trim().toLocaleLowerCase().startsWith(typed)) return setActive(at);
    }
  };
  const move = (from: number, step: number) => {
    const list = rows();
    for (let at = from + step; at >= 0 && at < list.length; at += step) if (enabled(list[at])) return setActive(at);
  };
  const rebuild = () => {
    menu.replaceChildren();
    // Only the options it offers set its width (a hidden or marked long name does not stretch it).
    sizer.replaceChildren(...Array.from(select.options).filter(option => !option.hidden).map(option => { const line = doc.createElement("span"); line.textContent = option.textContent ?? ""; return line; }));
    let index = 0;
    const row = (option: HTMLOptionElement) => {
      const item = doc.createElement("div");
      item.className = "custom-select-option";
      item.id = `${id}-${index++}`;
      item.dataset.value = option.value;
      item.textContent = option.textContent ?? "";
      item.setAttribute("role", "option");
      if (option.disabled) item.setAttribute("aria-disabled", "true");
      item.addEventListener("mousedown", event => { event.preventDefault(); event.stopPropagation(); commit(option); });
      return item;
    };
    // tagName, not instanceof: the options belong to the studio's realm. Hidden options (and a
    // group whose options are all hidden) are not drawn.
    const shown = (option: Element): option is HTMLOptionElement => option.tagName === "OPTION" && !(option as HTMLOptionElement).hidden;
    for (const child of Array.from(select.children)) {
      if (child.tagName === "OPTGROUP") {
        const options = Array.from(child.children).filter(shown);
        if (!options.length) continue;
        const group = doc.createElement("div");
        group.className = "custom-select-group";
        group.setAttribute("role", "presentation");
        group.textContent = (child as HTMLOptGroupElement).label;
        menu.append(group, ...options.map(row));
      } else if (shown(child)) menu.append(row(child));
    }
  };
  const sync = () => {
    if (ownPicker) trigger.setAttribute("aria-expanded", String(select.getAttribute("aria-expanded") === "true"));
    root.classList.toggle("disabled", select.disabled);
    trigger.disabled = select.disabled;
    const selected = select.options[select.selectedIndex];
    // A long option may give a short form for the closed control (data-short: a marked font name, the
    // mark first); the full text stays its title and the open list's row.
    const full = selected?.textContent?.trim() || "";
    const short = selected?.dataset.short?.trim();
    value.textContent = short || full;
    value.title = full;
    // Shown short, the control's name says the whole thing (after the list's own label), not only the short form.
    const name = short ? [label, selected?.dataset.spoken?.trim() || full].filter(Boolean).join(", ") : label;
    if (name) { if (trigger.getAttribute("aria-label") !== name) trigger.setAttribute("aria-label", name); }
    else trigger.removeAttribute("aria-label");
    for (const item of rows()) item.setAttribute("aria-selected", String(Boolean(selected) && item.dataset.value === selected.value));
  };

  // Whether the studio's picker was open when this press began (its own capture handler closes it first).
  let pressedOpen = false;
  const notePress = (event: Event) => { if (root.contains(event.target as Node)) pressedOpen = select.getAttribute("aria-expanded") === "true"; };
  if (ownPicker) doc.addEventListener("pointerdown", notePress, true);
  trigger.addEventListener("mousedown", event => {
    event.preventDefault(); event.stopPropagation();
    if (ownPicker) {
      if (!pressedOpen) select.dispatchEvent(new (view.PointerEvent ?? view.MouseEvent)("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      pressedOpen = false;
      return;
    }
    if (isOpen()) close(); else open();
    trigger.focus();
  });
  trigger.addEventListener("dblclick", event => {
    select.dispatchEvent(new view.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    event.preventDefault(); event.stopPropagation();
  });
  trigger.addEventListener("keydown", event => {
    if (select.disabled || event.isComposing) return;
    if (ownPicker) {
      if (["ArrowDown", "ArrowUp", "Enter", " ", "Escape"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        select.dispatchEvent(new view.KeyboardEvent("keydown", { key: event.key, code: event.code, bubbles: true, cancelable: true }));
      }
      return;
    }
    const list = rows();
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (!isOpen()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " " || (event.altKey && event.key === "ArrowDown")) { open(); handled(); }
      return;
    }
    if (event.key === "Escape") { close(); handled(); }
    else if (event.key === "Tab") close();
    else if (event.key === "ArrowDown") { move(active, 1); handled(); }
    else if (event.key === "ArrowUp") { move(active, -1); handled(); }
    else if (event.key === "Home") { move(-1, 1); handled(); }
    else if (event.key === "End") { move(list.length, -1); handled(); }
    else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) { seek(event.key); handled(); }
    else if (event.key === "Enter" || event.key === " ") {
      const row = list[active];
      const option = row && Array.from(select.options).find(item => item.value === row.dataset.value);
      if (option) commit(option); else close();
      handled();
    }
  });
  trigger.addEventListener("blur", () => setTimeout(() => { if (!root.contains(doc.activeElement)) close(); }, 0));

  // The studio sets the value in code as the caret moves (no change event): follow it.
  const proto = view.HTMLSelectElement.prototype;
  for (const name of ["value", "selectedIndex"] as const) {
    const native = Object.getOwnPropertyDescriptor(proto, name)!;
    Object.defineProperty(select, name, {
      configurable: true,
      get() { return native.get!.call(this); },
      set(next) { native.set!.call(this, next); sync(); },
    });
  }
  const observer = new view.MutationObserver(() => { rebuild(); sync(); });
  observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "label", "aria-expanded", "hidden", "data-short", "data-spoken"] });
  select.addEventListener("change", sync);
  rebuild();
  sync();

  enhanced.set(select, {
    root, sync, close,
    restore() {
      close();
      observer.disconnect();
      select.removeEventListener("change", sync);
      doc.removeEventListener("pointerdown", notePress, true);
      delete (select as unknown as Record<string, unknown>).value;
      delete (select as unknown as Record<string, unknown>).selectedIndex;
      select.classList.remove(hiddenClass);
      if (previous.tabIndex === null) select.removeAttribute("tabindex"); else select.setAttribute("tabindex", previous.tabIndex);
      if (previous.hidden === null) select.removeAttribute("aria-hidden"); else select.setAttribute("aria-hidden", previous.hidden);
      if (root.isConnected) root.replaceWith(select);
      else if (place.parent && !select.isConnected) place.parent.insertBefore(select, place.next);
      enhanced.delete(select);
    },
  });
  return true;
}
