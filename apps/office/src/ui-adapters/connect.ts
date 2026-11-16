import { listen, post, type Init } from "../bridge.ts";
import { applyOfficeTheme, mountOfficeUi, type OfficeUiFormat, type UiTheme } from "../ui-adapters.ts";
import { keepEditorAiPanelClosed } from "./ai-panel.ts";
import { installEditorAiDock } from "./editor-ai-dock.ts";

/** Editors whose own AI panel is the document's 문서 AI (the Hangul studio has its own dock, hwp-ai-dock.ts; e-books and mind maps keep theirs as they were). */
const DOCK_FORMATS: ReadonlySet<OfficeUiFormat> = new Set(["word", "slides", "sheets", "pdf", "markdown", "html"]);

/** Mounted by each actual editor entrypoint, alongside its original renderer bridge. */
export function connectOfficeUi(init: Init, format: OfficeUiFormat, command: (id: string) => unknown, theme: (theme: UiTheme) => void) {
  if (init.headlessExport) return;
  // One AI on a new person's document: the editor's own panel starts closed (its rail key stays).
  keepEditorAiPanelClosed(localStorage);
  const ui = mountOfficeUi({ viewId: init.artifact.id, format, theme: init.theme, onCommand: command, onTheme: theme });
  // The head's 문서 AI opens and closes the editor's own panel, which reports its state back (one door).
  const dock = DOCK_FORMATS.has(format) ? installEditorAiDock(document, { post }) : null;
  const stop = listen(message => {
    if (message.type === "office:show-commands") ui.show();
    if (message.type === "office:ai-panel-set") dock?.set(message.open, message.draft);
    if (message.type === "office:ai-draft-set") dock?.put(message.draft);
    if (message.type === "office:theme") void applyOfficeTheme(init.artifact.id, message.theme, message.palette ?? null);
  });
  window.addEventListener("pagehide", () => { dock?.dispose(); stop(); ui.dispose(); }, { once: true });
}
