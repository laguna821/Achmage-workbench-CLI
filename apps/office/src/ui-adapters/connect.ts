import { listen, type Init } from "../bridge.ts";
import { applyOfficeTheme, mountOfficeUi, type OfficeUiFormat, type UiTheme } from "../ui-adapters.ts";

/** Mounted by each actual editor entrypoint, alongside its original renderer bridge. */
export function connectOfficeUi(init: Init, format: OfficeUiFormat, command: (id: string) => unknown, theme: (theme: UiTheme) => void) {
  if (init.headlessExport) return;
  const ui = mountOfficeUi({ viewId: init.artifact.id, format, theme: init.theme, onCommand: command, onTheme: theme });
  const stop = listen(message => {
    if (message.type === "office:show-commands") ui.show();
    if (message.type === "office:theme") void applyOfficeTheme(init.artifact.id, message.theme);
  });
  window.addEventListener("pagehide", () => { stop(); ui.dispose(); }, { once: true });
}
