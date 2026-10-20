import { type RefObject, useEffect } from 'react'
import { useCollabSession } from '../collab/context'
import type { PeerView } from '../collab/presence'
import { useEditor } from '../context'

/**
 * Tells the others where this user's pointer and window are (in page coordinates, so zoom and scroll do not
 * matter), and moves this window along when the user follows somebody. Mounted by the workspace; does nothing
 * without a live session.
 */
export function usePresenceTracking(scrollRef: RefObject<HTMLDivElement | null>, artboards: RefObject<Map<string, HTMLDivElement>>): void {
  const session = useCollabSession()
  const editor = useEditor()

  useEffect(() => {
    const scroller = scrollRef.current
    if (!session || !scroller) return
    const presence = session.presence

    const onMove = (event: PointerEvent): void => {
      const board = (event.target instanceof Element ? event.target.closest<HTMLElement>('[data-artboard]') : null) ?? null
      const pageId = board?.dataset.pageId
      if (!board || !pageId) {
        presence.setCursor(null)
        return
      }
      const rect = board.getBoundingClientRect()
      const zoom = editor.state.zoom
      presence.setCursor({ pageId, x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom })
    }
    const onLeave = (): void => presence.setCursor(null)

    let frame = 0
    const reportView = (): void => {
      frame = 0
      const view = viewAt(scroller, artboards.current, editor.state.zoom)
      presence.setView(view)
    }
    const scheduleView = (): void => {
      if (!frame) frame = requestAnimationFrame(reportView)
    }
    scroller.addEventListener('pointermove', onMove, { passive: true })
    scroller.addEventListener('pointerleave', onLeave)
    scroller.addEventListener('scroll', scheduleView, { passive: true })
    const offZoom = editor.store.subscribe((state, prev) => {
      if (state.zoom !== prev.zoom || state.doc.pages !== prev.doc.pages) scheduleView()
    })
    scheduleView()

    let expectedZoom: number | null = null
    const center = (view: PeerView): void => {
      const board = artboards.current.get(view.pageId)
      if (!board) {
        editor.view.scrollToPage(view.pageId, 'auto')
        return
      }
      const zoom = editor.state.zoom
      const b = board.getBoundingClientRect()
      const s = scroller.getBoundingClientRect()
      scroller.scrollBy({ left: b.left + view.x * zoom - (s.left + s.width / 2), top: b.top + view.y * zoom - (s.top + s.height / 2), behavior: 'auto' })
    }
    const follow = (view: PeerView): void => {
      const current = editor.state.zoom
      if (Math.abs(view.zoom - current) / current > 0.01) {
        editor.view.setZoom(view.zoom)
        expectedZoom = editor.state.zoom
      }
      requestAnimationFrame(() => requestAnimationFrame(() => center(view)))
    }
    const offFollow = presence.store.subscribe((state, prev) => {
      if (state.following === null) {
        expectedZoom = null
        return
      }
      const peer = state.peers.find((p) => p.clientId === state.following)
      const before = prev.peers.find((p) => p.clientId === state.following)
      if (peer?.view && (state.following !== prev.following || JSON.stringify(peer.view) !== JSON.stringify(before?.view))) follow(peer.view)
    })
    const takeOver = (): void => {
      if (presence.store.getState().following !== null) presence.follow(null)
    }
    const offUserZoom = editor.store.subscribe((state, prev) => {
      if (state.zoom !== prev.zoom && expectedZoom !== null && state.zoom !== expectedZoom) takeOver()
    })
    scroller.addEventListener('wheel', takeOver, { passive: true })
    scroller.addEventListener('pointerdown', takeOver, { passive: true })
    return () => {
      scroller.removeEventListener('pointermove', onMove)
      scroller.removeEventListener('pointerleave', onLeave)
      scroller.removeEventListener('scroll', scheduleView)
      scroller.removeEventListener('wheel', takeOver)
      scroller.removeEventListener('pointerdown', takeOver)
      offZoom()
      offFollow()
      offUserZoom()
      if (frame) cancelAnimationFrame(frame)
      presence.setCursor(null)
    }
  }, [session, editor, scrollRef, artboards])
}

/** The page nearest to the middle of the window and the point of it at that middle. */
function viewAt(scroller: HTMLElement, boards: ReadonlyMap<string, HTMLElement>, zoom: number): PeerView | null {
  const s = scroller.getBoundingClientRect()
  const cx = s.left + s.width / 2
  const cy = s.top + s.height / 2
  let best: { id: string; rect: DOMRect; gap: number } | null = null
  for (const [id, board] of boards) {
    const rect = board.getBoundingClientRect()
    const gap = cy < rect.top ? rect.top - cy : cy > rect.bottom ? cy - rect.bottom : 0
    if (!best || gap < best.gap) best = { id, rect, gap }
  }
  if (!best || zoom <= 0) return null
  return {
    pageId: best.id,
    x: Math.min(best.rect.width / zoom, Math.max(0, (cx - best.rect.left) / zoom)),
    y: Math.min(best.rect.height / zoom, Math.max(0, (cy - best.rect.top) / zoom)),
    zoom,
  }
}
