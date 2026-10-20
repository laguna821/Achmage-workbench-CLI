/**
 * Comment pins on the artboard. The host lives in the workspace; for every page that is on (or near) the screen it puts
 * a layer inside that page's artboard, so a pin is drawn in page coordinates and zoom, pan and scroll move it with the
 * page for free. Pages that are far away have no layer at all (and so no pins in the DOM), which keeps a design with
 * hundreds of comments light. See commentGeometry.ts for the maths.
 */
import { MapPin } from 'lucide-react'
import { type RefObject, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, useEditorState } from '../context'
import type { EditorEngine } from '../engine/editor'
import { pinsByPage, readingOrder } from '../panels/commentOps'
import { setCommentMode } from '../panels/commentsMode'
import { cancelDraft, openThread, useCommentActions, useCommentsController, useVisibleThreads } from '../panels/commentsUi'
import { t } from '../strings'
import { Button } from '../ui/Button'
import { CommentPinLayer } from './CommentPinLayer'
import { focusPin } from './commentDom'
import { type PinsContextValue, PinsContext } from './commentPinsContext'
import { useArtboards } from './useArtboards'
import styles from './CommentPins.module.css'

interface CommentPinsProps {
  scrollRef: RefObject<HTMLDivElement | null>
  artboards: RefObject<Map<string, HTMLDivElement>>
}

/**
 * The ids of the pages that are within a screen of the visible area (more precisely: 60 % of the viewport above and
 * below it). Their layers are drawn; the others are not. Without `IntersectionObserver` every page counts as visible.
 */
function useVisiblePages(scrollRef: RefObject<HTMLDivElement | null>, elements: ReadonlyMap<string, HTMLDivElement>, enabled: boolean): ReadonlySet<string> {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  const supported = typeof IntersectionObserver !== 'undefined'
  useEffect(() => {
    const root = scrollRef.current
    if (!enabled || !supported || !root) return
    const ids = new Map([...elements].map(([id, el]) => [el, id]))
    const inside = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = ids.get(entry.target as HTMLDivElement)
          if (!id) continue
          if (entry.isIntersecting) inside.add(id)
          else inside.delete(id)
        }
        setSeen(new Set(inside))
      },
      { root, rootMargin: '60% 0px 60% 0px' },
    )
    for (const el of elements.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [scrollRef, elements, enabled, supported])
  return useMemo(() => (supported ? seen : new Set(elements.keys())), [supported, seen, elements])
}

/** Esc, one step at a time: the comment being written, then the open thread, then comment mode itself. */
function useEscape(editor: EditorEngine, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || editor.state.ui.dialog) return
      const { draft, activeThreadId, mode } = editor.state.comments
      if (draft) {
        e.preventDefault()
        cancelDraft(editor)
      } else if (activeThreadId) {
        e.preventDefault()
        openThread(editor, null)
        focusPin(activeThreadId)
      } else if (mode) {
        e.preventDefault()
        setCommentMode(editor, false)
      }
    }
    // In the capture phase, so that it runs before the editor's own Esc (deselect), which would otherwise take the key first.
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [editor, enabled])
}

function ModeHint() {
  const editor = useEditor()
  const compact = useEditorState((s) => s.ui.compact)
  return (
    <div className={styles.hint} role="status" data-testid="comment-mode-hint">
      <MapPin size={15} aria-hidden="true" />
      <span>{compact ? t.comments.mode.hintTouch : t.comments.mode.hint}</span>
      <Button size="sm" variant="primary" onClick={() => setCommentMode(editor, false)} data-testid="comment-mode-done">
        {t.comments.mode.done}
      </Button>
    </div>
  )
}

export function CommentPins({ scrollRef, artboards }: CommentPinsProps) {
  const editor = useEditor()
  const controller = useCommentsController()
  const offered = !!editor.adapter.services.comments
  const mode = useEditorState((s) => s.comments.mode)
  const pinsOn = useEditorState((s) => s.comments.pins)
  const active = offered && pinsOn
  const elements = useArtboards(scrollRef, artboards)
  const visible = useVisiblePages(scrollRef, elements, active)
  const { shown, pageIds } = useVisibleThreads(controller)
  const actions = useCommentActions(controller)
  const byPage = useMemo(() => pinsByPage(shown), [shown])
  const order = useMemo(() => readingOrder(shown, pageIds), [shown, pageIds])
  const pageOf = useMemo(() => new Map(shown.flatMap((th) => (th.placement === 'pinned' && th.root.page_id ? [[th.root.id, th.root.page_id] as const] : []))), [shown])

  useEffect(() => (active ? controller.watch() : undefined), [active, controller])
  useEscape(editor, active)

  const value = useMemo<PinsContextValue>(() => ({ controller, actions, byPage, order, pageOf, scroller: scrollRef }), [controller, actions, byPage, order, pageOf, scrollRef])
  if (!active) return null
  return (
    <PinsContext.Provider value={value}>
      {[...elements].filter(([id]) => visible.has(id)).map(([id, element]) => createPortal(<CommentPinLayer pageId={id} />, element, id))}
      {mode ? <ModeHint /> : null}
    </PinsContext.Provider>
  )
}
