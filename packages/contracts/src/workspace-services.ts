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
