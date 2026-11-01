import type { SessionManager } from "./sessions.ts";
import type { OfficeControl } from "./office-control.mjs";
import type { OfficeOutputs } from "./office-output.ts";
import type { IeumOffice } from "./ieumoffice.ts";
export class OfficeMcp {
  constructor(manager: SessionManager, control: OfficeControl, dataDir: string, options?: { defaultSaveDir?: () => string; version?: string; ieum?: IeumOffice });
  readonly outputs: OfficeOutputs;
  start(): Promise<void>;
  invoke(channel: string, args?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}
