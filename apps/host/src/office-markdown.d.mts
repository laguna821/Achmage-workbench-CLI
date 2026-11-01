import type { OfficeMarkdownSnapshot } from "../../../packages/contracts/src/office-markdown.ts";
export function importedMarkdownSettings(raw: unknown): { patch: Record<string, any>; warnings: string[] };
export class OfficeMarkdown {
  constructor(dataDir: string, injected?: Record<string, any>);
  readonly path: string;
  snapshot(): OfficeMarkdownSnapshot;
  write(patch: unknown, revision: string, options?: { backup?: boolean; signal?: AbortSignal; beforeCommit?: () => void }): Promise<{ snapshot: OfficeMarkdownSnapshot; backup: string | null }>;
  upload(data: unknown, signal?: AbortSignal, authorize?: () => void): Promise<{ ok: boolean; url?: string; error?: string }>;
  readImage(url: unknown, signal?: AbortSignal): Promise<{ base64: string; mime: string } | null>;
  close(): void;
}
