import type { DocumentAccess } from "@workbench/contracts";
export class OfficeImageOutputs {
  constructor(documents: import("./artifacts.ts").Documents);
  prepare(artifactId: string, revision: number, parent: string, name: string, access?: DocumentAccess): Promise<{ id: string }>;
  write(artifactId: string, id: string, page: number, base64: string, access?: DocumentAccess): Promise<{ ok: true }>;
  finish(artifactId: string, id: string, success: boolean, access?: DocumentAccess): Promise<{ ok: true; path?: string; canceled?: true }>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}
