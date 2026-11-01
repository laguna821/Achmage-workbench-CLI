import { normalizeAiPanelPrefs } from "../../../vendor/ieumoffice/packages/ui/src/ai-panel-prefs.ts";
import type { OfficePreferencesSnapshot } from "../../../packages/contracts/src/office-preferences.ts";
import { Gateway, post, type Init } from "./bridge.ts";

export function legacyOfficePanel(key: string) {
  try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}

/** One host store, original editor events; old per-editor preferences remain a fallback. */
export async function createOfficePreferences(init: Init, gateway: Gateway, notify: (channel: string, value: unknown) => void, legacy: unknown = {}) {
  const fallback = normalizeAiPanelPrefs(legacy), controller = new AbortController();
  let value: OfficePreferencesSnapshot = { revision: "", author: { value: "", fallback: "User" }, aiPanel: fallback, panelConfigured: false, documentTheme: "follow", autoSaveDefault: { on: false, updatedAt: 0 } };
  let generation = 0, busy = 0;
  const take = (next: OfficePreferencesSnapshot, announce = true) => {
    const previous = value;
    value = { ...next, aiPanel: next.panelConfigured ? next.aiPanel : fallback };
    if (!announce) return;
    for (const [field, channel] of [["aiPanel", "app:ai-panel-prefs-changed"], ["autoSaveDefault", "app:auto-save-default-changed"], ["documentTheme", "app:document-theme-changed"]] as const)
      if (JSON.stringify(previous[field]) !== JSON.stringify(value[field])) notify(channel, value[field]);
    const name = value.author.value || value.author.fallback;
    if (name !== (previous.author.value || previous.author.fallback)) notify("app:author-name-changed", name);
  };
  const refresh = async (announce = true) => {
    const turn = ++generation; busy++;
    try { const next = await gateway.aiSession(init.artifact.id).json<OfficePreferencesSnapshot>("preferences", undefined, controller.signal); if (turn === generation) take(next, announce); }
    finally { busy--; }
  };
  await refresh(false).catch(error => post({ type: "office:error", message: error instanceof Error ? error.message : String(error) }));
  const poll = () => { if (!busy && !controller.signal.aborted) void refresh().catch(() => {}); };
  const timer = window.setInterval(poll, 2500);
  window.addEventListener("focus", poll);
  window.addEventListener("pagehide", () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", poll); }, { once: true });
  return {
    panel: () => value.aiPanel, author: () => value.author, name: () => value.author.value || value.author.fallback,
    theme: () => value.documentTheme, autoSave: () => value.autoSaveDefault,
    async setPanel(patch: unknown) {
      const turn = ++generation; busy++;
      try {
        const next = await gateway.aiSession(init.artifact.id).json<OfficePreferencesSnapshot>("preferences-panel", { patch, legacy: fallback }, controller.signal);
        if (turn === generation) take(next);
        return next.aiPanel;
      } finally { busy--; }
    },
  };
}
