export function parseFileToText(path: string): Promise<{ ok: boolean; kind: 'text' | 'image' | 'unsupported'; text?: string; error?: string }>;
