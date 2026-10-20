/** Everything comment-related that sits on one page: its pins, the surface that catches clicks in comment mode, and the spot of a comment being written. */
import { MessageSquarePlus } from 'lucide-react'
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef } from 'react'
import { useEditor, useEditorState, useEditorStateShallow } from '../context'
import { getPageSize } from '../engine/pageSizes'
import type { EditorEngine } from '../engine/editor'
import { useLatest } from '../hooks/useLatest'
import { roundPoint } from '../panels/commentOps'
import type { CommentsController } from '../panels/commentsController'
import { ensureCommenter, startDraft } from '../panels/commentsUi'
import { t } from '../strings'
import { DraftCardFloat } from './CommentCard'
import { CommentPin } from './CommentPin'
import { clampToPage, layoutPins, snapToDevice } from './commentGeometry'
import { takePlacement } from './commentPlacement'
import { usePins } from './commentPinsContext'
import { useDevicePixelRatio } from './useDevicePixelRatio'
import surface from './CommentSurface.module.css'
import styles from './CommentPins.module.css'

/** The spot of the comment being written: a ghost pin with the card that holds the text box. */
function DraftSpot({ pageId, zoom, devicePixelRatio }: { pageId: string; zoom: number; devicePixelRatio: number }) {
  const draft = useEditorState((s) => (s.comments.draft?.pageId === pageId ? s.comments.draft : null))
  const spot = useRef<HTMLDivElement>(null)
  if (!draft) return null
  return (
    <>
      <div ref={spot} className={styles.pin} data-draft="" data-testid="comment-draft-pin" style={{ left: snapToDevice(draft.x * zoom, devicePixelRatio), top: snapToDevice(draft.y * zoom, devicePixelRatio) }} aria-hidden="true">
        <MessageSquarePlus size={14} aria-hidden="true" />
      </div>
      <DraftCardFloat draft={draft} anchorRef={spot} />
    </>
  )
}

/** Starts a comment at a point of a page (`null`: its middle), once the person is known to be allowed to comment. */
async function placeComment(editor: EditorEngine, controller: CommentsController, pageId: string, size: { width: number; height: number }, at: { x: number; y: number } | null): Promise<void> {
  const point = clampToPage(size, at ?? { x: size.width / 2, y: size.height / 2 })
  if (!(await ensureCommenter(editor, controller))) return
  const spot = roundPoint(point.x, point.y)
  startDraft(editor, pageId, spot.x, spot.y)
}

export function CommentPinLayer({ pageId }: { pageId: string }) {
  const editor = useEditor()
  const { byPage, controller, actions } = usePins()
  const zoom = useEditorState((s) => s.zoom)
  const mode = useEditorState((s) => s.comments.mode)
  const activeId = useEditorState((s) => s.comments.activeThreadId)
  const pageIndex = useEditorState((s) => s.doc.pages.findIndex((p) => p.id === pageId))
  const size = useEditorStateShallow((s) => getPageSize(s.doc, pageId))
  const devicePixelRatio = useDevicePixelRatio()
  const threads = byPage.get(pageId)

  const sizeRef = useLatest(size)
  // A click that came while the pins were still downloading (see `CommentPinsLoader.tsx`) starts its comment now.
  useEffect(() => {
    const held = takePlacement(editor, pageId)
    if (held) void placeComment(editor, controller, pageId, sizeRef.current, held.point)
  }, [editor, controller, pageId, sizeRef])

  // A pin stays on its page even when the page was made smaller after the comment was written.
  const spots = useMemo(() => new Map((threads ?? []).map((th) => [th.root.id, clampToPage(size, { x: th.root.x ?? 0, y: th.root.y ?? 0 })])), [threads, size])
  const offsets = useMemo(() => layoutPins([...spots].map(([id, at]) => ({ id, x: at.x, y: at.y })), zoom), [spots, zoom])
  if (pageIndex < 0) return null
  const pageNumber = pageIndex + 1
  const tabStop = threads?.some((th) => th.root.id === activeId) ? activeId : threads?.[0]?.root.id

  const place = (client: { x: number; y: number } | null): void => {
    void placeComment(editor, controller, pageId, size, client ? editor.view.clientToPage(pageId, client.x, client.y) : null)
  }

  const onSurfaceClick = (e: MouseEvent<HTMLDivElement>): void => {
    const ui = editor.state.ui
    if (ui.spaceDown || ui.tool === 'hand') return
    // A click made by the keyboard has no pointer position: the comment goes to the middle of the page.
    place(e.detail === 0 ? null : { x: e.clientX, y: e.clientY })
  }
  const onSurfaceKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    place(null)
  }

  return (
    <div className={styles.layer} data-comment-layer={pageId} role="group" aria-label={t.comments.pin.layer(pageNumber, threads?.length ?? 0)}>
      {mode ? (
        <div
          className={surface.surface}
          role="button"
          tabIndex={0}
          aria-label={t.comments.mode.surface(pageNumber)}
          aria-description={t.comments.mode.surfaceHelp}
          data-comment-surface={pageId}
          data-testid="comment-surface"
          onClick={onSurfaceClick}
          onKeyDown={onSurfaceKey}
        />
      ) : null}
      {(threads ?? []).map((th) => {
        const offset = offsets.get(th.root.id)
        const at = spots.get(th.root.id) ?? { x: 0, y: 0 }
        return (
          <CommentPin
            key={th.root.id}
            thread={th}
            pageId={pageId}
            zoom={zoom}
            left={at.x * zoom + (offset?.dx ?? 0)}
            top={at.y * zoom + (offset?.dy ?? 0)}
            previewLeft={at.x > size.width * 0.6}
            movable={actions.rights(th.root).move}
            tabStop={th.root.id === tabStop}
            devicePixelRatio={devicePixelRatio}
          />
        )
      })}
      <DraftSpot pageId={pageId} zoom={zoom} devicePixelRatio={devicePixelRatio} />
    </div>
  )
}
