/**
 * The Hangul editor's own AI dock (Ieum's AiDock / AiPanel) is the document's one AI entry while
 * the editor is open: named 문서 AI, opened and closed from the tab's 문서 AI button, and reporting
 * its open state and its input to the tab. Driven through the dock's own rail and collapse buttons,
 * so its React state, history and the editor stay as they are (no source edit, no remount).
 */
export const DOCK_NAME = "문서 AI";
const OLD_NAME = "AI 도우미";
/** The renderer's own remembered open state (apps/hwp App.tsx AI_OPEN_KEY). */
const OPEN_KEY = "hwpapp.showAi";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
/** The studio's own dialogs, each appended to its body while open (rhwp-studio ui/dialog.ts, find-dialog.ts, compare-dialog.ts…). */
const STUDIO_DIALOG = ".modal-overlay, .dialog-wrap, .find-dialog, .compare-dialog, [role=\"dialog\"]";
/** On the page's root while a studio dialog is open (the narrow layout's dock steps aside, hangul-studio.css). */
const ASIDE = "data-wb-studio-dialog";
/** On the page's root while the person brought the dock back over the open dialogs (ruling D). */
const OVER = "data-wb-ai-over";

/**
 * `ready`: the dock is drawn (the renderer draws it only once the editor is ready); before that no
 * state is reported, and a request is answered `ready: false` so the tab asks again. `person`: the
 * state changed by the dock's own button, not by a request of the tab (the tab takes it as its wish).
 * `shown`: open AND on screen — false while the open dock steps aside for a studio dialog (the tab's
 * button follows this, never `open` alone).
 */
type DockReport = { type: "office:ai-panel"; ready: boolean; open: boolean; shown: boolean; draft: string; person: boolean };

/** Closed by default: the page gets the editor's width until the person opens 문서 AI (then remembered). */
export function closeAiDockByDefault(storage: Storage): void {
  try { if (storage.getItem(OPEN_KEY) === null) storage.setItem(OPEN_KEY, "0"); } catch { /* storage unavailable: the renderer's default */ }
}

export function installHwpAiDock(doc: Document, { post }: { post(message: DockReport): void }) {
  const view = doc.defaultView!;
  const dock = () => doc.querySelector<HTMLElement>(".hwp-app .ai-dock");
  const isOpen = () => { const element = dock(); return Boolean(element && !element.classList.contains("collapsed")); };
  const input = () => dock()?.querySelector<HTMLTextAreaElement>(".ai-input-box textarea") ?? null;
  let last = "";
  /** The state last reported while drawn (null: not reported yet), and the state the tab asked for. */
  let shown: boolean | null = null;
  let requested: boolean | null = null;
  const report = (force = false) => {
    const ready = Boolean(dock());
    // Nothing is said before the dock exists: a "closed" then would be taken for the drawn dock's state.
    if (!ready && !force && shown === null) return;
    const open = ready && isOpen();
    const visible = open && view.getComputedStyle(dock()!).visibility !== "hidden";
    const person = ready && shown !== null && open !== shown && requested !== open;
    if (ready && requested === open) requested = null;
    if (ready) shown = open; else shown = null;
    const message: DockReport = { type: "office:ai-panel", ready, open, shown: visible, draft: input()?.value ?? "", person };
    const key = JSON.stringify({ ...message, person: false });
    if (force || person || key !== last) { last = key; post(message); }
  };
  /**
   * The document's one draft put into the dock's input IN PLACE of what it held (never added to it:
   * a hidden dock's old text must not come back stacked over the new one), as typing would (React
   * hears the input event). Kept until the input is drawn. Always answered with a report.
   */
  let pending: string | null = null;
  const apply = () => {
    const box = input();
    if (pending === null || !box) return false;
    const text = pending; pending = null;
    if (box.value !== text) {
      Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
      box.dispatchEvent(new view.Event("input", { bubbles: true }));
    }
    return true;
  };
  const put = (text: string) => {
    pending = text;
    apply();
    report(true);
  };
  const rename = () => {
    const element = dock();
    if (!element) return;
    for (const node of element.querySelectorAll<HTMLElement>("[aria-label], [data-tip]")) {
      if (node.getAttribute("aria-label") === OLD_NAME) node.setAttribute("aria-label", DOCK_NAME);
      const tip = node.getAttribute("data-tip");
      if (tip?.includes(OLD_NAME)) node.setAttribute("data-tip", tip.replace(OLD_NAME, DOCK_NAME));
    }
    const title = element.querySelector(".ai-panel-title");
    if (title) for (const text of Array.from(title.childNodes)) if (text.nodeType === 3 && text.textContent?.trim() === OLD_NAME) text.textContent = DOCK_NAME;
  };
  const root = doc.documentElement;
  const observer = new view.MutationObserver(() => {
    rename(); apply();
    // Brought over the dialogs until the person closes it (or the dialogs close).
    if (!isOpen() && root.hasAttribute(OVER)) root.removeAttribute(OVER);
    report();
  });
  observer.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "aria-label", "data-tip"] });
  // Shown or not also changes with the page's root (a studio dialog, brought over) and its width (narrow / wide layout).
  observer.observe(root, { attributes: true, attributeFilter: [ASIDE, OVER] });
  const resized = () => report();
  view.addEventListener("resize", resized);
  // What is typed in the dock is told to the tab at once (typing does not change the page), so a
  // switch of view right after the last key keeps it.
  const typed = (event: Event) => {
    if (!(event.target as Element | null)?.closest?.(".ai-dock .ai-input-box")) return;
    report();
  };
  doc.addEventListener("input", typed, true);
  rename();
  report();
  return {
    /** Open or close the dock with its own buttons, as a person would; always answered with a report. `draft`: put in its input (see `put`). */
    set(open: boolean, draft?: string) {
      if (draft !== undefined) pending = draft;
      if (!dock()) { report(true); return; }
      apply();
      // Asked to open (the person pressed 문서 AI) while a studio dialog is open: the dock comes over
      // it — never a press that shows nothing (ruling D). It stays until closed or the dialogs close.
      if (open && root.hasAttribute(ASIDE) && !root.hasAttribute(OVER)) {
        root.setAttribute(OVER, "");
        if (isOpen()) view.requestAnimationFrame?.(() => input()?.focus());
      }
      if (open === isOpen()) { report(true); return; }
      requested = open;
      const button = open ? dock()?.querySelector<HTMLElement>(".ai-rail") : dock()?.querySelector<HTMLElement>(".ai-panel-collapse");
      button?.click();
      if (open) view.requestAnimationFrame?.(() => input()?.focus());
    },
    put,
    dispose() {
      observer.disconnect();
      doc.removeEventListener("input", typed, true);
      view.removeEventListener("resize", resized);
    },
  };
}


/**
 * At a narrow pane the open dock lies over the page (hangul-studio.css); while one of the studio's
 * own dialogs is open the page says so on its root and the dock steps aside (hidden, not closed:
 * its open state and text stay; it reports itself not shown, so the tab's button is not pressed),
 * back when the dialog closes. A request to open brings it over the dialogs (`OVER`, see `set`)
 * until a further dialog opens or they all close. When they close, the dock gets the focus (if
 * nothing has it: the studio's Esc leaves it on its body) ONLY when it had the focus before the
 * dialogs or the person brought it over them — a dock that merely came back by itself never takes
 * the keys from the document (what is typed after Esc must not land in the AI's input).
 */
export function stepAsideForStudioDialogs(page: Document, studio: Document): () => void {
  const view = studio.defaultView;
  if (!view || !studio.body) return () => {};
  const root = page.documentElement;
  const pageView = page.defaultView!;
  let seen = new Set<Element>();
  let hadFocus = false;
  const overPage = () => {
    const dock = page.querySelector<HTMLElement>(".hwp-app .ai-dock:not(.collapsed)");
    return dock && (pageView.getComputedStyle(dock).visibility === "hidden" || root.hasAttribute(OVER)) ? dock : null;
  };
  const update = () => {
    const dialogs = Array.from(studio.body.children).filter(element => element.matches(STUDIO_DIALOG) && !(element as HTMLElement).hidden && view.getComputedStyle(element).display !== "none");
    const open = dialogs.length > 0;
    // A further dialog of the studio: the dock steps aside for it too.
    if (dialogs.some(element => !seen.has(element))) root.removeAttribute(OVER);
    seen = new Set(dialogs);
    if (open === root.hasAttribute(ASIDE)) return;
    if (open) hadFocus = !!page.querySelector(".hwp-app .ai-dock")?.contains(page.activeElement);
    const dock = !open && (hadFocus || root.hasAttribute(OVER)) ? overPage() : null;
    root.toggleAttribute(ASIDE, open);
    if (!open) root.removeAttribute(OVER);
    if (dock) view.setTimeout(() => {
      const inStudio = studio.activeElement;
      const nowhere = (page.activeElement === page.body || page.activeElement?.tagName === "IFRAME") && (!inStudio || inStudio === studio.body);
      if (nowhere && !dock.classList.contains("collapsed")) dock.querySelector<HTMLTextAreaElement>(".ai-input-box textarea")?.focus();
    }, 0);
  };
  const observer = new view.MutationObserver(update);
  observer.observe(studio.body, { childList: true });
  update();
  return () => { observer.disconnect(); root.removeAttribute(ASIDE); root.removeAttribute(OVER); };
}
