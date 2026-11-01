import type { SessionManager } from "./sessions.ts";
import type { EditorGrants } from "./editors.ts";
import type { KnowledgeLibrary, KnowledgeHit } from "../../../packages/contracts/src/office-knowledge.ts";
export class OfficeKnowledge {
  constructor(dataDir: string, manager: SessionManager);
  readonly fileSearch: import("./office-file-search.mjs").OfficeFileSearch;
  readonly path: string;
  readonly home: {
    open(): string;
    require(owner: string): { id: number; controller: AbortController };
    close(owner: string): void;
    cancel(owner: string): void;
    invoke(owner: string, channel: string, args: unknown[], destination: unknown, signal: AbortSignal): Promise<unknown>;
  };
  library(): KnowledgeLibrary;
  manage(action: unknown, input?: Record<string, unknown>, signal?: AbortSignal): Promise<KnowledgeLibrary | KnowledgeHit[]>;
  tool(name: string, args: unknown[], signal: AbortSignal): Promise<unknown>;
  open(artifactId: string, token: string, grants: EditorGrants, path: unknown): { artifactId: string; workId: string; workspaceId?: string };
  close(): void;
}
