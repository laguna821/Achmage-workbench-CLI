import type { OfficeDriveState, OfficeDrivePick, OfficeDriveAttachments, OfficeDrivePrompt, OfficeDriveNotice } from "../../../packages/contracts/src/office-drive.ts";
export function buildDriveClient(): { clientId: string; clientSecret: string } | null;
export function driveTokenVault(path: string, vault: { seal(value: string): Promise<string>; open(value: string): Promise<string> }): { load(): Promise<string | null>; save(value: string): Promise<boolean>; clear(): Promise<void> };
export class OfficeDrive {
  constructor(manager: import("./sessions.ts").SessionManager | null, control: import("./office-control.mjs").OfficeControl, dataDir: string, injected?: Record<string, any>);
  start(): Promise<void>;
  state(): OfficeDriveState;
  enabled(): boolean;
  list(listing: unknown, pageToken?: string): Promise<any>;
  open(id: string): Promise<{ ok: boolean; kind?: string }>;
  reopen(artifactId: string): Promise<{ handled: boolean; ok?: boolean; kind?: string }>;
  attach(picks: OfficeDrivePick[], register?: (bytes: Buffer, name: string) => string): Promise<OfficeDriveAttachments>;
  tool(name: string, args: unknown[]): Promise<any>;
  activity(): { prompts: OfficeDrivePrompt[]; notices: OfficeDriveNotice[] };
  answer(id: string, value?: string): { ok: boolean };
  invoke(channel: string, args?: unknown[], signal?: AbortSignal): Promise<any>;
  close(): void;
}
