/** The cards that open next to a pin: a thread (read it, reply, resolve, delete) and a new comment being written. */
import { X } from 'lucide-react'
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, useEditorState, usePortalRoot } from '../context'
import { CommentComposer } from '../panels/CommentParts'
import { ReplyComposer, ThreadActions, ThreadEntries } from '../panels/CommentThreadParts'
import { patchComments } from '../panels/commentsMode'
import { cancelDraft, ensureCommenter, openThread, setDraftBody } from '../panels/commentsUi'
import type { Thread } from '../panels/commentOps'
import type { CommentDraft } from '../store/editorStore'
import { t } from '../strings'
import { IconButton } from '../ui/Button'
import { type Box, isAnchorVisible, placeCard } from './commentGeometry'
import { focusPin, pinSelector } from './commentDom'
import { usePins } from './commentPinsContext'
import styles from './CommentCard.module.css'

const box = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height })

interface FloatingProps {
  anchorRef: RefObject<HTMLElement | null>
  label: string
  testId: string
  /** A press outside the card and its pin: false keeps the card open (it holds something the person is writing). */
  shouldDismiss: (target: Element) => boolean
  onDismiss: () => void
  children: ReactNode
}

/**
 * A card next to its anchor. It stays inside the workspace, follows the anchor while the page scrolls or zooms, hides
 * while the anchor is scrolled out of view (what was typed in it stays), and on small screens sits at the bottom.
 */
export function FloatingCard({ anchorRef, label, testId, shouldDismiss, onDismiss, children }: FloatingProps) {
  const root = usePortalRoot()
  const compact = useEditorState((s) => s.ui.compact)
  const { scroller } = usePins()
  const cardRef = useRef<HTMLDivElement>(null)

  const reposition = useCallback(() => {
    const card = cardRef.current
    const anchor = anchorRef.current
    if (!card || !anchor) return
    const a = box(anchor.getBoundingClientRect())
    const area = box((scroller.current ?? document.documentElement).getBoundingClientRect())
    if (compact) {
      delete card.dataset.hidden
    } else {
      const at = placeCard(a, { width: card.offsetWidth, height: card.offsetHeight }, area, 10, 8)
      card.style.left = `${Math.round(at.left)}px`
      card.style.top = `${Math.round(at.top)}px`
      card.dataset.side = at.side
      if (isAnchorVisible(a, area)) delete card.dataset.hidden
      else card.dataset.hidden = 'true'
    }
    card.dataset.placed = 'true'
  }, [anchorRef, scroller, compact])

  useLayoutEffect(() => {
    reposition()
  })

  useEffect(() => {
    const card = cardRef.current
    let frame = 0
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        reposition()
      })
    }
    const observer = card && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    if (card) observer?.observe(card)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [reposition])

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target
      if (!(target instanceof Element) || cardRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      if (shouldDismiss(target)) onDismiss()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [anchorRef, shouldDismiss, onDismiss])

  if (!root) return null
  return createPortal(
    <div ref={cardRef} className={styles.card} role="dialog" aria-label={label} data-testid={testId} data-compact={compact || undefined} tabIndex={-1}>
      {children}
    </div>,
    root,
  )
}

export function ThreadCardFloat({ thread, anchorRef }: { thread: Thread; anchorRef: RefObject<HTMLElement | null> }) {
  const editor = useEditor()
  const { actions } = usePins()
  const compact = useEditorState((s) => s.ui.compact)
  const id = thread.root.id
  const close = useCallback(() => {
    openThread(editor, null)
    focusPin(id)
  }, [editor, id])
  const dismiss = useCallback(() => openThread(editor, null), [editor])
  const outside = useCallback((target: Element) => !target.closest(pinSelector(id)), [id])
  const label = t.comments.pin.thread(thread.number ?? 0)
  return (
    <FloatingCard anchorRef={anchorRef} label={label} testId="pin-card" shouldDismiss={outside} onDismiss={dismiss}>
      <header className={styles.head}>
        <span className={styles.number} data-resolved={thread.root.resolved || undefined}>
          {thread.number}
        </span>
        <h3 className={styles.title}>{label}</h3>
        {thread.replies.length > 0 ? <small className={styles.meta}>{t.comments.pin.replies(thread.replies.length)}</small> : null}
        <span className={styles.grow} />
        <IconButton label={t.comments.close} size="sm" onClick={close} data-testid="pin-close">
          <X size={16} aria-hidden="true" />
        </IconButton>
      </header>
      <div className={styles.scroll}>
        <ThreadEntries thread={thread} actions={actions} idPrefix="pin" />
      </div>
      <ThreadActions thread={thread} actions={actions} idPrefix="pin" />
      <ReplyComposer thread={thread} actions={actions} idPrefix="pin" autoFocus={!compact} />
    </FloatingCard>
  )
}

export function DraftCardFloat({ draft, anchorRef }: { draft: CommentDraft; anchorRef: RefObject<HTMLElement | null> }) {
  const editor = useEditor()
  const { controller } = usePins()
  const hasText = draft.body.trim().length > 0
  // Pressing on the page moves the spot (the surface handles it); pressing anywhere else closes an empty draft only.
  const outside = useCallback((target: Element) => !hasText && !target.closest('[data-comment-surface]'), [hasText])
  const dismiss = useCallback(() => cancelDraft(editor), [editor])
  return (
    <FloatingCard anchorRef={anchorRef} label={t.comments.pin.newCard} testId="pin-draft-card" shouldDismiss={outside} onDismiss={dismiss}>
      <div className={styles.draft}>
        <CommentComposer
          placeholder={t.comments.pin.newPlaceholder}
          submitLabel={t.comments.post}
          testId="pin-compose"
          autoFocus
          refocusKey={`${draft.x},${draft.y}`}
          value={draft.body}
          onChange={(body) => setDraftBody(editor, body)}
          onCancel={dismiss}
          cancelLabel={t.comments.cancel}
          onSubmit={async (body) => {
            if (!(await ensureCommenter(editor, controller))) return false
            const made = await controller.create({ body, page_id: draft.pageId, x: draft.x, y: draft.y })
            const nonce = (editor.state.comments.reveal?.nonce ?? 0) + 1
            patchComments(editor, { draft: null, reveal: { id: made.id, nonce, focus: false } })
            editor.announce(t.comments.announce.added)
          }}
        />
      </div>
    </FloatingCard>
  )
}
