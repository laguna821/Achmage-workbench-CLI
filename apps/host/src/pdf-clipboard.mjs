import { HttpError } from './errors.ts';

/** Pages copied in a Workbench window's PDF tabs (IeumOffice v0.13.0's page clipboard, D1). The gateway holds them, so
 * a paste reads neither a path nor bytes from the page. One slot per window, bounded in size and time, in memory only
 * (gone when the gateway quits): another window, a paired phone's page or a document AI run never reads it. */
export const PDF_CLIPBOARD_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_CLIPBOARD_TTL_MS = 30 * 60_000;
const MAX_WINDOWS = 16;

export class PdfPageClipboard {
  constructor(now = Date.now) { this.now = now; this.slots = new Map(); }
  get size() { this.prune(); return this.slots.size; }
  prune() { const now = this.now(); for (const [key, slot] of this.slots) if (slot.expires <= now) this.slots.delete(key); }
  hold(windowId, pages) {
    if (pages.bytes.length > PDF_CLIPBOARD_MAX_BYTES) throw new HttpError(413, 'pdf_clipboard_size', '복사한 쪽이 너무 큽니다. 쪽을 나누어 복사해 주세요.');
    this.prune(); this.slots.delete(windowId);
    while (this.slots.size >= MAX_WINDOWS) this.slots.delete(this.slots.keys().next().value);
    this.slots.set(windowId, { bytes: pages.bytes, count: pages.count, expires: this.now() + PDF_CLIPBOARD_TTL_MS });
  }
  held(windowId) { this.prune(); return this.slots.get(windowId) ?? null; }
  count(windowId) { return this.held(windowId)?.count ?? 0; }
  clear() { this.slots.clear(); }
}
