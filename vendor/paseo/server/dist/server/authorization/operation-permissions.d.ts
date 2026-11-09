import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { DaemonPermission } from "./index.js";
type InboundOperation = SessionInboundMessage["type"];
export type PermissionRequirement = DaemonPermission | readonly DaemonPermission[] | null;
export declare function requiredPermissionForInbound(operation: InboundOperation): PermissionRequirement;
export declare function requiredPermissionForOutbound(message: SessionOutboundMessage): PermissionRequirement;
export {};
