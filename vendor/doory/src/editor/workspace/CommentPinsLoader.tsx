import { type KeyboardEvent, type MouseEvent, type RefObject, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, useEditorState, useEditorStateShallow } from '../context'
import { t } from '../strings'
import { loadable } from '../ui/loadable'
import { holdPlacement } from './commentPlacement'
import { useArtboards } from './useArtboards'
import surface from './CommentSurface.module.css'

type Artboards = RefObject<Map<string, HTMLDivElement>>
interface PinsProps {
  scrollRef: RefObject<HTMLDivElement | null>
  artboards: Artboards
}

/**
 * While the code of the pins downloads, comment mode already works: every page gets a surface that behaves like the real
 * one (a crosshair over the page, nothing under it sees the pointer) and keeps the click. The pins' layer of that page
 * starts the comment from it the moment it is drawn (`commentPlacement.ts`), so a click made right after the Comments
 * button was pressed is never lost to the download.
 */
function WaitingSurfaces({ scrollRef, artboards }: PinsProps) {
  const editor = useEditor()
  const mode = useEditorState((s) => s.comments.mode)
  const pageIds = useEditorStateShallow((s) => s.doc.pages.map((p) => p.id))
  const elements = useArtboards(scrollRef, artboards)
  if (!mode) return null

  const hold = (pageId: string, client: { x: number; y: number } | null): void => {
    const ui = editor.state.ui
    if (ui.spaceDown || ui.tool === 'hand') return
    holdPlacement(editor, pageId, client ? editor.view.clientToPage(pageId, client.x, client.y) : null)
  }

  return (
    <>
      {[...elements].map(([id, element]) =>
        createPortal(
          <div
            className={`${surface.surface} ${surface.waiting}`}
            role="button"
            tabIndex={0}
            aria-label={t.comments.mode.surface(pageIds.indexOf(id) + 1)}
            aria-description={t.comments.mode.surfaceHelp}
            aria-busy="true"
            data-testid="comment-surface"
            onClick={(e: MouseEvent<HTMLDivElement>) => hold(id, e.detail === 0 ? null : { x: e.clientX, y: e.clientY })}
            onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              hold(id, null)
            }}
          />,
          element,
          id,
        ),
      )}
    </>
  )
}

// The pin layers are only drawn while the Comments sidebar is open (or pins were left on), so their code waits for that.
const Pins = loadable(() => import('./CommentPins').then((m) => m.CommentPins), { fallback: (props) => <WaitingSurfaces {...props} /> })

/**
 * The comment pins over the pages (see `CommentPins.tsx`), fetched the first time the comments are shown. The download
 * starts as soon as the Comments sidebar is asked for, alongside the sidebar's own code and not after it.
 */
export function LazyCommentPins({ scrollRef, artboards }: PinsProps) {
  const editor = useEditor()
  const offered = !!editor.adapter.services.comments
  const pinsOn = useEditorState((s) => s.comments.pins)
  const sidebarOpen = useEditorState((s) => s.ui.panelId === 'comments')
  useEffect(() => {
    if (offered && sidebarOpen) void Pins.preload()
  }, [offered, sidebarOpen])
  return offered && pinsOn ? <Pins scrollRef={scrollRef} artboards={artboards} /> : null
}

/** Starts downloading the pins; the Comments button calls it when it is hovered or focused. */
LazyCommentPins.preload = Pins.preload
