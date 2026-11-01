export type OfficePanelPreferences = {
  side: "left" | "right"; fontSize: "default" | "large" | "xlarge" | "custom";
  customFontSize: number; spellcheck: boolean; openInNewDocs: boolean; showAiSidebar: boolean;
};
export type OfficePreferencesSnapshot = {
  revision: string;
  author: { value: string; fallback: string };
  aiPanel: OfficePanelPreferences; panelConfigured: boolean;
  documentTheme: "follow" | "light" | "dark";
  autoSaveDefault: { on: boolean; updatedAt: number };
};
export const OFFICE_PREFERENCES_CHANNELS = new Set([
  "home:get-author-name", "home:set-author-name", "home:get-ai-panel-prefs", "home:set-ai-panel-prefs",
  "home:get-document-theme", "home:set-document-theme", "home:get-auto-save-default", "home:set-auto-save-default",
]);
