export type OfficeWikiAction = "resolve" | "backlinks" | "graph" | "open" | "take-fragment";
export type OfficeWikiRequest = { type: "office:wiki"; requestId: string; action: OfficeWikiAction; input: Record<string, unknown> };
export type OfficeWikiResult = { type: "office:wiki-result"; requestId: string; value?: unknown; error?: string };
export type WikiLink = { path: string; fragment: string; found: boolean };
export type WikiBacklink = { source: string; target: string };
export type WikiGraph = { nodes: { path: string; name: string; relPath: string }[]; edges: { from: string; to: string }[]; truncated: boolean; totalNotes: number };
