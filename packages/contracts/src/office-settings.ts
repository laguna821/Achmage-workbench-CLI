/** Only this surface is available to the dedicated Office settings frame. */
export const OFFICE_SETTINGS_CHANNELS = new Set([
  "ai:get-settings", "ai:set-settings", "ai:chat", "ai:codex-models", "ai:custom-models",
  "ai:local-models", "ai:local-inspect", "ai:local-test", "ai:local-test-cancel",
  "ai:media-test", "ai:search-test", "ai:free-connect", "ai:free-connect-cancel",
  "ai:free-disconnect", "ai:free-quota", "ai:free-open-key-page",
  "ai:subscription-statuses", "ai:subscription-recheck", "ai:subscription-login",
  "ai:subscription-logout", "ai:subscription-install", "ai:subscription-update",
  "ai:subscription-cancel-login", "ai:subscription-metered", "ai:subscription-codex-image",
  "home:open-subscription-install-help", "home:open-connect-help",
  "home:get-file-search-settings", "home:set-file-search-settings", "home:test-file-search-rerank",
]);
export type OfficeSettingsFrameRequest = { type: "office-settings:request"; requestId: string; channel: string; args: unknown[]; revision?: string };
export type OfficeSettingsFrameReply = { type: "office-settings:reply"; requestId: string; value?: unknown; error?: string };
