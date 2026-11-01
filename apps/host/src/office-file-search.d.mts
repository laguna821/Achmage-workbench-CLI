import type { SearchPage } from "@workbench/contracts";
import type { SessionManager } from "./sessions.ts";
import type { Documents } from "./artifacts.ts";
import type { OfficeVault } from "./office-vault.ts";
export type FileSearchSettings = { rerank: boolean; endpoint: string; keys: Record<string, string>; customBaseUrl: string; customModel: string; cloudflareAccountId: string; cloudflareModel: string };
export type FileSearchSnapshot = { revision: string; settings: FileSearchSettings };
export function mapFileSearchKeys(raw: unknown, map: (value: string) => string): any;
export function importedFileSearch(raw: unknown, map: (value: string) => string): FileSearchSettings | null;
export class OfficeFileSearch {
  constructor(dataDir: string, injected?: { vault?: OfficeVault; send?: (...args: any[]) => Promise<any> });
  readonly path: string;
  snapshot(): FileSearchSnapshot;
  write(draft: unknown, revision: string, options?: { backup?: boolean; signal?: AbortSignal; beforeCommit?: () => void }): Promise<{ snapshot: FileSearchSnapshot; backup: string | null }>;
  probe(draft: unknown, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
  rank(query: string, candidates: string[], documents: Documents, allowed: (path: string) => boolean, signal?: AbortSignal): Promise<{ order: string[]; scores: Record<string, number> } | null>;
  rankPage(query: string, page: SearchPage, manager: SessionManager, signal?: AbortSignal): Promise<SearchPage>;
  close(): void;
}
