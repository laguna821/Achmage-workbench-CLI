export type KnowledgeFile = { path: string; name: string; folder: string; folderPath: string; ext: string; sizeBytes: number };
export type KnowledgeEntry = { path: string; group?: string; missing: boolean; file?: KnowledgeFile };
export type KnowledgeLibrary = { items: KnowledgeEntry[]; groups: string[] };
export type KnowledgeHit = { path: string; name: string; ext: string; folder: string; snippet: string };
export type KnowledgeOpenRequest = { type: "office:knowledge-open"; requestId: string; path: string };
export type KnowledgeOpenResult = { type: "office:knowledge-result"; requestId: string; error?: string };
