/**
 * The editors' own AI panel (Word, PowerPoint, Excel, PDF, Markdown, HTML) is the document's one 문서 AI
 * while the editor is on screen (unit one-doc-ai, the owner 2026-11-16: "둘중 하나만"): the tab's 문서 AI key
 * opens and closes it, and it reports its state the way the Hangul dock does (hwp-ai-dock.ts), so the tab
 * runs one rule for every editor. Driven through the panel's own rail and collapse buttons (no source
 * edit, no remount). Its name is changed at build time (korean-copy.ts), not here.
 *
 * Shapes: Word, PowerPoint, PDF, Markdown and HTML draw `.ai-dock` (`.collapsed` while closed, `.ai-rail`
 * the key, `.ai-panel-collapse` the close button); Excel draws `aside.copilot` (`.collapsed` + `.expand-copilot`
 * while closed). A person who turned the panel off (설정 › 연결, `showAiSidebar`) gets `.ai-dock-off` on the dock
 * (Excel: on `.sheet-body`) and no rail: reported `off`, and the tab then opens 문서 AI as the conversation column.
 */
export type EditorAiReport = { type: "office:ai-panel"; ready: boolean; open: boolean; shown: boolean; draft: string; person: boolean; off: boolean };

export function installEditorAiDock(doc: Document, { post }: { post(message: EditorAiReport): void }) {
  const view = doc.defaultView!;
  const panel = () => doc.querySelector<HTMLElement>(".ai-dock") ?? doc.querySelector<HTMLElement>(".copilot");
  const isOpen = () => { const element = panel(); return Boolean(element && !element.classList.contains("collapsed")); };
  const isOff = () => !isOpen() && Boolean(doc.querySelector(".ai-dock-off"));
  const input = () => (isOpen() ? panel()?.querySelector<HTMLTextAreaElement>("textarea") : null) ?? null;
  const openKey = () => doc.querySelector<HTMLElement>(".ai-dock.collapsed .ai-rail, .copilot.collapsed .expand-copilot");
  const closeKey = () => panel()?.querySelector<HTMLElement>(".ai-panel-collapse") ?? null;
  let last = "";
  let shown: boolean | null = null;
  let requested: boolean | null = null;
  /** The last text the panel's input held while open (a closed panel has no input: its draft is kept). */
  let draft = "";
  const report = (force = false) => {
    const ready = Boolean(panel());
    if (!ready && !force && shown === null && !isOff()) return;
    const open = ready && isOpen();
    const person = ready && shown !== null && open !== shown && requested !== open;
    if (ready && requested === open) requested = null;
    shown = ready ? open : null;
    const box = input();
    if (box) draft = box.value;
    const message: EditorAiReport = { type: "office:ai-panel", ready, open, shown: open, draft, person, off: isOff() };
    const key = JSON.stringify({ ...message, person: false });
    if (force || person || key !== last) { last = key; post(message); }
  };
  /** The document's one draft, put in the panel's input in place of what it held (as typing would), once the input is drawn. */
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
  let frame = 0;
  let retry = 0;
  const later = () => {
    if (frame) return;
    frame = view.requestAnimationFrame?.(() => { frame = 0; apply(); report(); }) ?? 0;
    if (!frame) { apply(); report(); }
  };
  // Any change (the panel's class, its subtree, the page) is looked at once a frame: the report is cheap and
  // said only when it differs.
  const observer = new view.MutationObserver(later);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  const typed = (event: Event) => { if ((event.target as Element | null)?.closest?.(".ai-dock, .copilot")) report(); };
  doc.addEventListener("input", typed, true);
  report();
  return {
    /** Open or close the panel with its own buttons, as a person would; always answered with a report. */
    set(open: boolean, text?: string) {
      if (text !== undefined) pending = text;
      view.clearTimeout(retry);
      if (!panel()) { report(true); return; }
      apply();
      if (open === isOpen()) { requested = null; report(true); return; }
      requested = open;
      const key = open ? openKey() : closeKey();
      if (key) key.click();
      else report(true);
      if (open) view.requestAnimationFrame?.(() => { apply(); input()?.focus(); });
      // A rail drawn a moment ago can swallow its first click (Markdown after 보이기 off → on): while the wish
      // still stands and the panel is still closed, press again, a few times at most (re-review 1, next round 1).
      if (open && key) {
        let left = 5;
        const again = () => {
          if (requested !== true || isOpen() || !panel() || left-- <= 0) return;
          openKey()?.click();
          retry = view.setTimeout(again, 80);
        };
        retry = view.setTimeout(again, 80);
      }
    },
    put(text: string) { pending = text; apply(); report(true); },
    /** Report as a dock drawn a moment ago (the editor pool opened another document in this page): never as the person's change. */
    again() { shown = null; requested = null; last = ""; report(true); },
    dispose() {
      observer.disconnect();
      view.clearTimeout(retry);
      if (frame) view.cancelAnimationFrame?.(frame);
      doc.removeEventListener("input", typed, true);
    },
  };
}
