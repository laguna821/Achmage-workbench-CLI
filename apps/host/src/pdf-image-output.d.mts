import type { DocumentAccess } from '@workbench/contracts';
import type { Documents } from './artifacts.ts';
export function pdfImageOutputs(documents: Documents): {
  prepare(artifactId: string, revision: unknown, parent: unknown, name: unknown, access?: DocumentAccess): Promise<{ id: string }>;
  write(artifactId: string, id: string, request: unknown, access?: DocumentAccess): Promise<{ ok: true }>;
  run<T>(artifactId: string, id: string, access: DocumentAccess, revision: number, task: (path: string) => Promise<T>): Promise<T>;
  finish(artifactId: string, id: string, success: unknown, access?: DocumentAccess): Promise<{ ok: true; path?: string; files?: string[]; canceled?: true }>;
  prune(): Promise<void>;
  close(): Promise<void>;
};
