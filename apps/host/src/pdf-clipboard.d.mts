export const PDF_CLIPBOARD_MAX_BYTES: number;
export const PDF_CLIPBOARD_TTL_MS: number;
export type CopiedPdfPages = { bytes: Uint8Array; count: number };
export class PdfPageClipboard {
  constructor(now?: () => number);
  readonly size: number;
  hold(windowId: string, pages: CopiedPdfPages): void;
  held(windowId: string): CopiedPdfPages | null;
  count(windowId: string): number;
  clear(): void;
}
