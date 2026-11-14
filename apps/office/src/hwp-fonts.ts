import type { HostFontSnapshot } from "../../../packages/contracts/src/hwp-fonts.ts";
import { authoringFallbackForFontFamily, fontFamilyKey, installedFontKeys, sanitizeAuthoringFontFamily, type InstalledFamilies } from "../../../third_party/hop/font-authoring-policy.ts";

export type FaceRegistration = { family: string; url: string; weight: "400" | "700" };

/**
 * The bundled OFL faces (third_party/hop/fonts, copied into the studio's fonts/). Upstream's own
 * table already draws HY faces with these files; 함초롬 has only a CDN supply there (off in this
 * offline build), and "Noto Sans KR" / "Noto Serif KR" end upstream's fallback chains. A face is
 * registered only when the PC has no font of that name: installed fonts come first.
 */
export const HWP_FALLBACK_FACES: readonly FaceRegistration[] = [
  { family: "함초롬바탕", url: "fonts/NotoSerifKR-Regular.woff2", weight: "400" },
  { family: "함초롬바탕", url: "fonts/NotoSerifKR-Bold.woff2", weight: "700" },
  { family: "함초롬돋움", url: "fonts/NotoSansKR-Regular.woff2", weight: "400" },
  { family: "함초롬돋움", url: "fonts/NotoSansKR-Bold.woff2", weight: "700" },
  { family: "Noto Serif KR", url: "fonts/NotoSerifKR-Regular.woff2", weight: "400" },
  { family: "Noto Serif KR", url: "fonts/NotoSerifKR-Bold.woff2", weight: "700" },
  { family: "Noto Sans KR", url: "fonts/NotoSansKR-Regular.woff2", weight: "400" },
  { family: "Noto Sans KR", url: "fonts/NotoSansKR-Bold.woff2", weight: "700" },
];

/** Families the catalogue reports, with their localized aliases, as the rule's lookup (made once per catalogue). */
function installedFamilies(snapshot: HostFontSnapshot): InstalledFamilies {
  return installedFontKeys((Array.isArray(snapshot?.faces) ? snapshot.faces : []).flatMap(face => [face.family, ...(face.aliases ?? [])]).filter((name): name is string => typeof name === "string"));
}
/** Names drawn with the bundled faces when the PC lacks them (registered above): always offered. */
const BUNDLED = new Set(HWP_FALLBACK_FACES.map(face => fontFamilyKey(face.family)));

export type FontVerdict = {
  /** Offered in a list: the PC has it (any of its names), or it is a bundled face. */
  offer: boolean;
  /** What choosing it applies: 함초롬 for an HY / 휴먼 / HCI font the PC lacks (HOP's rule), else the name itself. */
  applied: string;
  /** How a list shows it: a missing name says what it is drawn like and keeps its own name. */
  label: string;
};

/**
 * THE font rule of the Hangul editor, used by every place that offers or accepts a font: names
 * this PC has (Korean and English names of a face count as one), plus the bundled 함초롬 / Noto
 * faces, are offered; anything else (HY / 휴먼 and other fonts it lacks, web-font names this
 * offline build cannot load, generic families) is not offered and, where a document already names
 * it, shown as "<name> (이 PC에 없음 → 함초롬돋움으로 보임)" without rewriting the document.
 */
export function fontVerdict(name: string, installed: InstalledFamilies): FontVerdict {
  const trimmed = name.trim(), key = fontFamilyKey(trimmed);
  if (!key || installed.has(key) || BUNDLED.has(key)) return { offer: Boolean(key), applied: trimmed, label: trimmed };
  return { offer: false, applied: sanitizeAuthoringFontFamily(trimmed, installed), label: missingLabel(trimmed) };
}
export const missingLabel = (name: string) => `${name} (이 PC에 없음 → ${authoringFallbackForFontFamily(name)}으로 보임)`;
/**
 * The same mark, short enough for a closed 140 px control (the mark first); the full label is its
 * title. The mark is U+26A0 with U+FE0E: its text form on every platform (WKWebView may otherwise
 * draw a colour emoji).
 */
export const missingShort = (name: string) => `\u26A0\uFE0E ${name}`;
/** What the control is named while it shows the short form: the whole meaning, said in words. */
export const missingSpoken = (name: string) => `${name}, 이 PC에 없음, ${authoringFallbackForFontFamily(name)}으로 보임`;
const subject = (name: string) => `${name}${/[가-힣]$/.test(name) && (name.charCodeAt(name.length - 1) - 0xac00) % 28 === 0 ? "는" : "은"}`;

/** The studio's own font sets (rhwp-studio core/user-settings.ts BUILTIN_FONT_SETS: one font each) and the person's (its stored settings). */
const BUILTIN_SETS: Record<string, string[]> = { "함초롬": ["함초롬바탕"], "함초롬돋움": ["함초롬돋움"], "맑은 고딕": ["맑은 고딕"], "바탕": ["바탕"] };
const SET_FIELDS = ["korean", "english", "chinese", "japanese", "other", "symbol", "user"] as const;
function fontSetMembers(view: Window, name: string): string[] | null {
  if (BUILTIN_SETS[name]) return BUILTIN_SETS[name];
  try {
    const sets = (JSON.parse(view.localStorage.getItem("rhwp-settings") ?? "null") as { font?: { fontSets?: Array<Record<string, string>> } } | null)?.font?.fontSets ?? [];
    const set = sets.find(item => item?.name === name);
    return set ? SET_FIELDS.map(field => set[field]).filter((font): font is string => typeof font === "string" && Boolean(font.trim())) : null;
  } catch { return null; }
}

/** The lists the studio builds from its font table: the style bar's, and every select with its 웹 글꼴 / 로컬 글꼴 groups (글자 모양, 글꼴 세트 편집). */
const FONT_GROUPS = new Set(["웹 글꼴", "로컬 글꼴", "대표 글꼴"]);
const isFontSelect = (element: Element | null): element is HTMLSelectElement =>
  element?.tagName === "SELECT" && (element.id === "font-name" || Array.from(element.children).some(child => child.tagName === "OPTGROUP" && FONT_GROUPS.has((child as HTMLOptGroupElement).label)));
/** 수식 속성's typed font name: the input in its row labelled 글꼴. */
const isEquationFont = (element: Element | null): element is HTMLInputElement =>
  element?.tagName === "INPUT" && Boolean(element.closest(".eq-props-dialog")) && element.closest(".eq-props-row")?.querySelector(".dialog-label")?.textContent?.trim() === "글꼴";
const NOTE_MS = 6000;

/**
 * HOP's HY / 휴먼 rule in the studio frame, as the one rule above, applied to every list and field
 * that offers or accepts a font: names it cannot draw are not offered (the document's own still
 * shows, marked), choosing an HY / 휴먼 font it lacks applies 함초롬 with a note, and the document
 * keeps every name it has. Runs on the studio's DOM; the studio's sources stay as they are.
 */
export function installHwpFontRule(doc: Document, catalogue: Promise<HostFontSnapshot>, options: { register?: (face: FaceRegistration) => void } = {}): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  // Unknown until the catalogue arrives; if it cannot be read, nothing is hidden, rewritten or shadowed.
  let installed: InstalledFamilies | null = null;
  let stopped = false;
  const added: FontFace[] = [];
  const register = options.register ?? ((face: FaceRegistration) => {
    const font = new view.FontFace(face.family, `url(${JSON.stringify(new URL(face.url, doc.baseURI).href)}) format("woff2")`, { weight: face.weight });
    doc.fonts.add(font); added.push(font);
    void font.load().catch(() => { /* a missing file leaves upstream's own chain */ });
  });
  const verdict = (name: string) => fontVerdict(name, installed!);
  const SET = "__fontset__";
  const setOffered = (name: string) => { const members = fontSetMembers(view, name); return members === null || members.every(member => verdict(member).offer); };
  /** Names as the studio wrote them (a label this rule changed keeps the name here). */
  const own = new WeakMap<Element, string>();
  const nameOf = (element: Element, fallback: string) => { if (!own.has(element)) own.set(element, fallback); return own.get(element)!; };
  /**
   * The document's own fonts a list stands for: values the studio set in code (the caret's font, a
   * language tab's), and the picker's 현재 / 문서 글꼴. Choosing one of them is never rewritten to the
   * substitute (the document's name stays); choosing the one the text already has changes nothing.
   */
  const documentFonts = new WeakMap<HTMLSelectElement, Set<string>>();
  const documentFontsOf = (select: HTMLSelectElement) => { let names = documentFonts.get(select); if (!names) documentFonts.set(select, names = new Set()); return names; };
  /** The value a list had before the person's choice (seen as it opens, or after the last choice). */
  const before = new WeakMap<HTMLSelectElement, string>();
  const remember = (select: HTMLSelectElement) => {
    const value = select.value;
    if (!value || value.startsWith(SET)) return;
    before.set(select, value);
    if (!verdict(value).offer) documentFontsOf(select).add(value);
  };

  const filterSelect = (select: HTMLSelectElement) => {
    if (installed === null) return;
    remember(select);
    for (const option of Array.from(select.options)) {
      let hide: boolean, label: string;
      if (option.value.startsWith(SET)) { hide = !setOffered(option.value.slice(SET.length)); label = option.textContent ?? ""; }
      // The document's own fonts this list stood for stay pickable for its lifetime (Hancom keeps the current font).
      else { const font = verdict(option.value); hide = !font.offer && option.value !== select.value && !documentFonts.get(select)?.has(option.value); label = font.label; }
      if (option.hidden !== hide) option.hidden = hide;
      const short = option.value && !option.value.startsWith(SET) && label !== option.value ? missingShort(option.value) : null;
      // The spoken form first: the drawn control redraws when data-short changes.
      if (short === null) { for (const name of ["data-spoken", "data-short"]) if (option.hasAttribute(name)) option.removeAttribute(name); }
      else {
        const spoken = missingSpoken(option.value);
        if (option.dataset.spoken !== spoken) option.dataset.spoken = spoken;
        if (option.dataset.short !== short) option.dataset.short = short;
      }
      if (option.value && !option.value.startsWith(SET) && option.textContent !== label) {
        // An option without a value attribute takes its value from its text: keep the name.
        if (!option.hasAttribute("value")) option.value = option.value;
        option.textContent = label;
      }
    }
  };
  const filterPicker = (menu: Element) => {
    // 현재 글꼴 / 문서 글꼴 say what the document uses: information, shown (marked where missing), not hidden.
    const category = menu.querySelector<HTMLElement>(".font-picker-category.active")?.dataset.category;
    const informs = category === "current" || category === "document";
    const bar = doc.getElementById("font-name");
    let shown = 0;
    for (const button of menu.querySelectorAll<HTMLElement>(".font-picker-option")) {
      const name = nameOf(button, button.textContent ?? "");
      let hide: boolean, label = name;
      if (category === "fontSets" || name.startsWith("◆ ")) hide = !setOffered(name.replace(/^◆\s*/, ""));
      else {
        const font = verdict(name); hide = !informs && !font.offer; label = font.label;
        if (informs && !font.offer && bar?.tagName === "SELECT") documentFontsOf(bar as HTMLSelectElement).add(name);
      }
      if (button.hidden !== hide) button.hidden = hide;
      if (button.textContent !== label) { button.textContent = label; button.title = label; }
      if (!hide) shown++;
    }
    const heading = menu.querySelector<HTMLElement>('[data-role="heading"]');
    const text = heading?.textContent?.replace(/\(\d+\)\s*$/, `(${shown})`);
    if (heading && text !== undefined && heading.textContent !== text) heading.textContent = text;
  };
  const filter = () => {
    if (installed === null) return;
    for (const select of doc.querySelectorAll("select")) if (isFontSelect(select)) filterSelect(select);
    for (const menu of doc.querySelectorAll(".font-picker-menu")) filterPicker(menu);
  };
  // Only changes to a font list or the studio's picker (not the page's own redraws, nor what this rule writes).
  const relevant = (record: MutationRecord) => {
    const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
    if (target?.closest('[data-role="heading"]')) return false;
    if (target?.closest(".font-picker-menu") || isFontSelect(target?.closest("select") ?? null)) return true;
    return Array.from(record.addedNodes).some(node => node.nodeType === 1 && ((node as Element).matches(".font-picker-menu, select") || (node as Element).querySelector(".font-picker-menu, select") !== null));
  };
  let writing = false;
  const observer = new view.MutationObserver(records => {
    // The note goes with the control it speaks of: a dialog closed (취소 too) applied nothing.
    if (noteNear && !noteNear.isConnected) say("");
    if (pending && !pending.control.isConnected) pending = null;
    if (writing || !records.some(relevant)) return;
    writing = true;
    try { filter(); } finally { observer.takeRecords(); writing = false; }
  });
  observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
  // The studio sets a list's value in code (a language tab, the caret): put the list right before it opens.
  const beforeOpen = (event: Event) => {
    const target = event.target as Element | null;
    const select = isFontSelect(target) ? target : target?.closest?.(".custom-select")?.querySelector("select") ?? null;
    if (isFontSelect(select)) filterSelect(select);
  };
  for (const type of ["pointerdown", "mousedown", "keydown", "focusin"]) doc.addEventListener(type, beforeOpen, true);

  // A substitution is said, next to the control it happened in, for a few seconds.
  let note: HTMLElement | null = null, noteTimer = 0, noteNear: Element | null = null;
  const say = (text: string, near?: Element | null) => {
    view.clearTimeout(noteTimer);
    noteNear = text ? near ?? null : null;
    if (!text) { if (note) note.textContent = ""; note?.setAttribute("hidden", ""); return; }
    if (!note) { note = doc.createElement("div"); note.className = "wb-font-note"; note.setAttribute("role", "status"); doc.body.append(note); }
    const anchor = near?.getBoundingClientRect();
    if (anchor) Object.assign(note.style, { left: `${Math.max(8, anchor.left)}px`, top: `${anchor.bottom + 4}px` });
    note.textContent = text; note.removeAttribute("hidden");
    noteTimer = view.setTimeout(() => say(""), NOTE_MS);
  };

  /**
   * A substitution picked inside a dialog that can still be cancelled: said as what the dialog will
   * apply; "…으로 적용했습니다" only once its 설정 / 확인 applied it (H2-R2-3).
   */
  const DIALOG = ".modal-overlay, .dialog-wrap";
  let pending: { control: Element; text: string } | null = null;
  const applyButton = (event: Event) => {
    const button = (event.target as Element | null)?.closest?.(".dialog-btn-primary");
    const held = pending;
    if (!button || !held || !button.closest(DIALOG)?.contains(held.control)) return;
    pending = null;
    // After the studio's own handler (it applies and closes the dialog); a dialog that stayed open applied nothing.
    view.setTimeout(() => {
      if (held.control.isConnected) { pending = held; return; }
      say(held.text, doc.querySelector("#style-bar .custom-select") ?? doc.getElementById("font-name"));
    }, 0);
  };
  doc.addEventListener("click", applyButton, true);

  // Capture: runs before the studio's own change handler on the list or field.
  const choose = (event: Event) => {
    const target = event.target as Element | null;
    if (installed === null || !(isFontSelect(target) || isEquationFont(target))) return;
    const value = target.value.trim();
    if (!value || value.startsWith(SET)) return;
    const near = target.closest(".custom-select") ?? target;
    if (pending?.control === target) pending = null;
    if (isFontSelect(target) && !verdict(value).offer && documentFontsOf(target).has(value)) {
      // The document's own font: the text that has it keeps it (no change at all); other text gets the name itself.
      const same = before.get(target) === value;
      before.set(target, value);
      say("");
      if (same) event.stopImmediatePropagation();
      return;
    }
    const next = verdict(value).applied;
    if (next === value) { if (isFontSelect(target)) before.set(target, value); say(""); return; }
    const applied = `${subject(value)} 이 PC에 없어 ${next}으로 적용했습니다.`;
    if (target.closest(DIALOG)) { pending = { control: target, text: applied }; say(`${subject(value)} 이 PC에 없어 ${next}으로 바꿔 둡니다.`, near); }
    else say(applied, near);
    if (isFontSelect(target) && !Array.from(target.options).some(option => option.value === next)) {
      const option = doc.createElement("option"); option.value = option.textContent = next; target.append(option);
    }
    target.value = next;
    if (isFontSelect(target)) before.set(target, next);
  };
  doc.addEventListener("change", choose, true);

  filter();
  void catalogue.then(snapshot => {
    if (stopped) return;
    installed = installedFamilies(snapshot);
    for (const face of HWP_FALLBACK_FACES) if (!installed.has(fontFamilyKey(face.family))) register(face);
    filter();
  }, () => { /* fail open: the studio as it was before this rule */ });

  return () => {
    stopped = true;
    observer.disconnect();
    doc.removeEventListener("change", choose, true);
    doc.removeEventListener("click", applyButton, true);
    for (const type of ["pointerdown", "mousedown", "keydown", "focusin"]) doc.removeEventListener(type, beforeOpen, true);
    view.clearTimeout(noteTimer); note?.remove(); note = null;
    for (const select of doc.querySelectorAll("select")) if (isFontSelect(select)) for (const option of Array.from(select.options)) {
      option.hidden = false;
      option.removeAttribute("data-short");
      option.removeAttribute("data-spoken");
      if (option.value && !option.value.startsWith(SET) && option.textContent !== option.value) option.textContent = option.value;
    }
    for (const button of doc.querySelectorAll<HTMLElement>(".font-picker-option")) { button.hidden = false; if (own.has(button)) button.textContent = own.get(button)!; }
    for (const font of added.splice(0)) doc.fonts.delete(font);
  };
}
