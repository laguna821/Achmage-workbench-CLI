import { type RefObject, useState, useSyncExternalStore } from 'react'

type Boards = ReadonlyMap<string, HTMLDivElement>

/**
 * The artboard elements of the pages that are mounted. The workspace keeps them in a ref and tells nobody when they
 * change; a page that appears or goes away always changes the DOM of the scroller, which is what this listens to.
 */
export class ArtboardTracker {
  private known: Boards = new Map()

  constructor(
    private readonly scroller: RefObject<HTMLElement | null>,
    private readonly boards: RefObject<Map<string, HTMLDivElement>>,
  ) {}

  subscribe = (notify: () => void): (() => void) => {
    const root = this.scroller.current
    if (!root || typeof MutationObserver === 'undefined') return () => undefined
    const observer = new MutationObserver(notify)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }

  /** The same map object until a page was added, removed or got a new element. */
  getSnapshot = (): Boards => {
    const live = this.boards.current
    const same = live.size === this.known.size && [...live].every(([id, el]) => this.known.get(id) === el)
    if (!same) this.known = new Map(live)
    return this.known
  }
}

export function useArtboards(scroller: RefObject<HTMLElement | null>, boards: RefObject<Map<string, HTMLDivElement>>): Boards {
  const [tracker] = useState(() => new ArtboardTracker(scroller, boards))
  return useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot)
}
