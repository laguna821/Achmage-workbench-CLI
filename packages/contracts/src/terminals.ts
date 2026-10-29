export type CreateTerminalRequest = { requestId: string; label?: string; shell?: string; args?: string[] };
export type TerminalSession = {
  id: string; workId: string; workspaceId: string; hostId: string; cwd: string; label: string;
  shell: string | null; args: string[];
  status: "starting" | "running" | "stopping" | "exited" | "interrupted" | "error";
  pid: number | null; exitCode: number | null; error: string | null;
  cols: number; rows: number; outputStart: number; outputEnd: number;
  createdAt: number; updatedAt: number;
};
export type TerminalOutput = { terminal: TerminalSession; start: number; end: number; data: string; truncated: boolean };
export type TerminalList = { available: boolean; terminals: TerminalSession[] };
