/** Full-app operations are never available through a document capability. */
export const OFFICE_DRIVE_SETTINGS_CHANNELS = new Set([
  "drive:state", "drive:connect", "drive:cancel-connect", "drive:disconnect", "drive:set-ai-access", "drive:list", "drive:open",
]);
export type OfficeDriveState = { state: "unavailable" } | { state: "disconnected"; expired: boolean; aiAccess: boolean }
  | { state: "connecting"; aiAccess: boolean } | { state: "connected"; name: string; email: string; persisted: boolean; aiAccess: boolean };
export type OfficeDrivePick = { id: string; folder: boolean };
export type OfficeDriveAttachments = { ok: true; paths: string[]; skipped: number; failed: number }
  | { ok: false; reason: "cancelled" | "busy" | "not-connected" };
export type OfficeDrivePrompt = { id: string; message: string; detail: string; choices: { value: "overwrite" | "copy" | "local"; label: string }[] };
export type OfficeDriveNotice = { id: string; message: string };
