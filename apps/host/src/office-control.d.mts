import type { SessionManager } from "./sessions.ts";
import type { EventBus } from "./bus.ts";
import type { ControlRequest, ControlReply, OfficeControlCommand } from "../../../packages/contracts/src/office-control.ts";
export class OfficeControl {
  constructor(manager: SessionManager, bus: EventBus, dataDir: string);
  start(): Promise<void>;
  handle(request: ControlRequest): Promise<ControlReply>;
  list(windowId: string, main: boolean): { commands: OfficeControlCommand[] };
  reply(id: string, windowId: string, reply: unknown): { accepted: boolean };
  close(): void;
}
