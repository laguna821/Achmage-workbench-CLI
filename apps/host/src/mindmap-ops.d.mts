export const MINDMAP_MAX_BYTES: number;
export type MindmapOpenStatus = "ok" | "legacy-format" | "encrypted" | "unreadable" | "rejected";
export function inspectMindmap(bytes: Uint8Array): Promise<MindmapOpenStatus>;
export function mindmapText(bytes: Uint8Array): Promise<string>;
