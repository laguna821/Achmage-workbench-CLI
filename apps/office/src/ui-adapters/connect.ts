import { listen, type Init } from "../bridge.ts";
import { applyOfficeTheme, mountOfficeUi, type OfficeUiFormat, type UiTheme } from "../ui-adapters.ts";
import { keepEditorAiPanelClosed } from "./ai-panel.ts";

/** Mounted by each actual editor entrypoint, alongside its original renderer bridge. */
export function connectOfficeUi(init: Init, format: OfficeUiFormat, command: (id: string) => unknown, theme: (theme: UiTheme) => void) {
  if (init.headlessExport) return;
  // One AI on a new person's document: the editor's own panel starts closed (its rail key stays).
  keepEditorAiPanelClosed(localStorage);
  const ui = mountOfficeUi({ viewId: init.artifact.id, format, theme: init.theme, onCommand: command, onTheme: theme });
  let opening = 0;
  // The head's ⋯ 편집기 안 AI 도우미 (I7): open the editor's own panel through its own rail key, once it
  // is there (after the preference to show it is turned back on, the editor shows it within seconds).
  // The Hangul studio handles this message itself (hwp.ts: its dock is the document's 문서 AI).
  const openPanel = (deadline: number) => {
    window.clearTimeout(opening);
    const key = document.querySelector<HTMLElement>(".ai-dock.collapsed .ai-rail, .copilot.collapsed .expand-copilot");
    if (key) { key.click(); return; }
    if (document.querySelector(".ai-dock:not(.collapsed), .copilot:not(.collapsed)")) return;
    if (Date.now() < deadline) opening = window.setTimeout(() => openPanel(deadline), 250);
  };
  const stop = listen(message => {
    if (message.type === "office:show-commands") ui.show();
    if (message.type === "office:ai-panel-set" && format !== "hangul" && message.open) openPanel(Date.now() + 6_000);
    if (message.type === "office:theme") void applyOfficeTheme(init.artifact.id, message.theme, message.palette ?? null);
  });
  window.addEventListener("pagehide", () => { window.clearTimeout(opening); stop(); ui.dispose(); }, { once: true });
}
