import { type RefObject, createContext, useContext } from 'react'
import type { Thread } from '../panels/commentOps'
import type { CommentsController } from '../panels/commentsController'
import type { CommentActions } from '../panels/commentsUi'

/** What every page layer of the pins needs from the host: the threads to draw, what may be done with them, where the scroller is. */
export interface PinsContextValue {
  controller: CommentsController
  actions: CommentActions
  /** The pinned threads the filter shows, by page. */
  byPage: ReadonlyMap<string, readonly Thread[]>
  /** The same threads in reading order: the order the arrow keys walk. */
  order: readonly string[]
  /** The page of each of them. */
  pageOf: ReadonlyMap<string, string>
  /** The workspace's scrolling element: the area cards must stay inside. */
  scroller: RefObject<HTMLDivElement | null>
}

export const PinsContext = createContext<PinsContextValue | null>(null)

export function usePins(): PinsContextValue {
  const value = useContext(PinsContext)
  if (!value) throw new Error('usePins must be used inside <CommentPins>')
  return value
}
