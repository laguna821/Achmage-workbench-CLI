import type { Artifact } from "./index.ts";
export type { ControlRequest, ControlReply, RendererControlRequest, RendererControlReply } from "../../../vendor/ieumoffice/packages/cli/src/control-protocol.ts";
import type { RendererControlRequest } from "../../../vendor/ieumoffice/packages/cli/src/control-protocol.ts";

export type OfficeControlCommand = { id: string; windowId: string | null } & (
  | { kind: "open"; artifact: Artifact }
  | { kind: "renderer"; viewId: string; request: RendererControlRequest }
  | { kind: "mcp"; viewId: string; request: import("./office-mcp.ts").OfficeMcpRequest }
);
