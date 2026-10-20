/**
 * A click on a page in comment mode that came before the code of the pins did (`CommentPinsLoader.tsx`). The loader's
 * stand-in surface holds the spot here; the pins' layer of that page takes it as soon as it is drawn and starts the
 * comment there, so a click is never lost to a download. The spot is kept in page coordinates, so scrolling or zooming
 * in the meantime does not move it.
 */
import type { EditorEngine } from '../engine/editor'

export interface HeldPlacement {
  pageId: string
  /** A point of the page; `null` (a click made with the keyboard) is the middle of the page. */
  point: { x: number; y: number } | null
  at: number
}

/** A click older than this was meant for something that is long gone (the code never came, or comment mode was left and re-entered). */
export const HOLD_MS = 15_000

const held = new WeakMap<EditorEngine, HeldPlacement>()

export function holdPlacement(editor: EditorEngine, pageId: string, point: HeldPlacement['point'], now = Date.now()): void {
  held.set(editor, { pageId, point, at: now })
}

/** The spot held for `pageId`, once: nothing when there is none, it is too old, or comment mode has been left since. */
export function takePlacement(editor: EditorEngine, pageId: string, now = Date.now()): HeldPlacement | null {
  const spot = held.get(editor)
  if (!spot || spot.pageId !== pageId) return null
  held.delete(editor)
  return now - spot.at <= HOLD_MS && editor.state.comments.mode ? spot : null
}
