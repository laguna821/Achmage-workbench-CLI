export type ReadingAnchor = { messageId: string; offsetPx: number };
export type ChatPosition = { top: number; follow: boolean; anchor?: ReadingAnchor };
type ReadingRow = { id: string; topPx: number; heightPx?: number };

export function reconcileReadingAnchor(anchor: ReadingAnchor, rows: ReadingRow[]): number | null {
  const row = rows.find(entry => entry.id === anchor.messageId);
  return row ? Math.max(0, row.topPx + anchor.offsetPx) : null;
}

function rowsOf(scroller: HTMLElement): ReadingRow[] {
  const top = scroller.getBoundingClientRect().top;
  return Array.from(scroller.querySelectorAll<HTMLElement>("[data-reading-id]")).map(element => {
    const box = element.getBoundingClientRect();
    return { id: element.dataset.readingId!, topPx: box.top - top + scroller.scrollTop, heightPx: box.height };
  }).filter(row => row.heightPx > 0);
}

export function captureReadingAnchor(scroller: HTMLElement): ReadingAnchor | null {
  const rows = rowsOf(scroller);
  const row = rows.find(entry => entry.topPx + (entry.heightPx ?? 0) > scroller.scrollTop + 1);
  return row ? { messageId: row.id, offsetPx: scroller.scrollTop - row.topPx } : null;
}

export function readingAnchorTop(scroller: HTMLElement, anchor: ReadingAnchor): number | null {
  return reconcileReadingAnchor(anchor, rowsOf(scroller));
}

export const nearTranscriptEnd = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
