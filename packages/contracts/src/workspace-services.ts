export type WorkspaceServiceStart = { requestId: string; label: string; command: string; port?: number };
export type WorkspaceService = {
  id: string; workspaceId: string; workId: string; hostId: string; cwd: string;
  label: string; command: string; port: number | null; url: string | null;
  terminalId: string; ownerId: string; startedAt: number;
  status: "starting" | "running" | "stopping" | "exited" | "interrupted" | "error";
  pid: number | null; exitCode: number | null; error: string | null;
};
export type WorkspaceServiceOwner = Pick<WorkspaceService, "ownerId" | "terminalId" | "startedAt">;
export type WorkspaceServiceList = { available: boolean; services: WorkspaceService[] };
export type WorkspaceServicePreview = { id: string; serviceId: string; workspaceId: string; url: string; openUrl: string; expiresAt: number };
export type WorkspaceServicePreviewSettings = { publicBaseUrl: string | null; remoteEnabled: boolean; message: string };
