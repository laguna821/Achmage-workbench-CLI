import { MapPin, MessageSquarePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useEditor, useEditorState } from '../context'
import { t } from '../strings'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { Skeleton } from '../ui/Skeleton'
import { CommentComposer } from './CommentParts'
import { ReplyComposer, ThreadActions, ThreadEntries } from './CommentThreadParts'
import { type Thread, countThreads, roundPoint } from './commentOps'
import type { CommentsController } from './commentsController'
import { setCommentMode, setCommentPins } from './commentsMode'
import { type CommentActions, ensureCommenter, revealThread, useCommentActions, useCommentsController, useVisibleThreads } from './commentsUi'
import styles from './Comments.module.css'
import brand from './Brand.module.css'

interface ThreadCardProps {
  thread: Thread
  actions: CommentActions
  active: boolean
  pageNumber: number | null
}

function ThreadCard({ thread, actions, active, pageNumber }: ThreadCardProps) {
  const editor = useEditor()
  const [replying, setReplying] = useState(false)
  const card = useRef<HTMLLIElement>(null)
  const { root, placement } = thread

  // A pin that was clicked brings its card into view in the list.
  useEffect(() => {
    if (active) card.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const where =
    placement === 'pinned' && pageNumber !== null && thread.number !== null ? (
      <button type="button" className={`${styles.page} ${styles.pinChip}`} onClick={() => revealThread(editor, thread)} aria-label={t.comments.showOnPage(thread.number, pageNumber)} data-testid="comment-show">
        <span className={styles.chipNumber}>{thread.number}</span>
        {t.comments.page(pageNumber)}
      </button>
    ) : placement === 'page' && pageNumber !== null ? (
      <button type="button" className={styles.page} onClick={() => editor.pages.activate(root.page_id ?? '')} aria-label={t.comments.goToPage(pageNumber)}>
        {t.comments.page(pageNumber)}
      </button>
    ) : placement === 'removed' ? (
      <span className={`${styles.page} ${styles.removed}`} title={t.comments.pageRemovedHint} data-testid="comment-page-removed">
        {t.comments.pageRemoved}
      </span>
    ) : null

  return (
    <li ref={card} className={styles.thread} data-resolved={root.resolved || undefined} data-active={active || undefined} data-testid="comment-thread" data-thread-id={root.id}>
      {where}
      <ThreadEntries thread={thread} actions={actions} idPrefix="comment" />
      {replying ? <ReplyComposer thread={thread} actions={actions} idPrefix="comment" autoFocus onSent={() => setReplying(false)} /> : null}
      <ThreadActions thread={thread} actions={actions} idPrefix="comment" onReply={replying ? undefined : () => setReplying(true)} />
    </li>
  )
}

function CommentsGate({ onDone }: { onDone: () => void }) {
  const editor = useEditor()
  const [busy, setBusy] = useState(false)
  return (
    <div className={brand.gate} data-testid="comments-gate">
      <strong>{t.comments.gateTitle}</strong>
      <span>{t.comments.gateBody}</span>
      <Button
        variant="primary"
        disabled={busy}
        data-testid="comments-signup"
        onClick={() => {
          setBusy(true)
          editor.adapter
            .requireAccount('comment', async () => ({ document: editor.getDocument(), title: editor.state.title }))
            .then((ok) => ok && onDone())
            .catch(() => undefined)
            .finally(() => setBusy(false))
        }}
      >
        {t.comments.gateAction}
      </Button>
    </div>
  )
}

function Filters({ counts, signedIn }: { counts: ReturnType<typeof countThreads>; signedIn: boolean }) {
  const editor = useEditor()
  const filter = useEditorState((s) => s.comments.filter)
  const options = [
    { value: 'all' as const, label: `${t.comments.filter.all} ${counts.all}` },
    { value: 'unresolved' as const, label: `${t.comments.filter.unresolved} ${counts.unresolved}` },
    ...(signedIn ? [{ value: 'mine' as const, label: `${t.comments.filter.mine} ${counts.mine}` }] : []),
  ]
  return <Segmented label={t.comments.filter.label} value={filter === 'mine' && !signedIn ? 'all' : filter} options={options} onChange={(value) => editor.store.setState((s) => ({ comments: { ...s.comments, filter: value } }))} className={styles.filters} />
}

function Comments({ controller, close }: { controller: CommentsController; close: () => void }) {
  const editor = useEditor()
  const doc = useEditorState((s) => s.doc)
  const activePageId = useEditorState((s) => s.activePageId)
  const selection = useEditorState((s) => s.selection)
  const readOnly = useEditorState((s) => s.readOnly)
  const compact = useEditorState((s) => s.ui.compact)
  const mode = useEditorState((s) => s.comments.mode)
  const pinsOn = useEditorState((s) => s.comments.pins)
  const filter = useEditorState((s) => s.comments.filter)
  const active = useEditorState((s) => s.comments.activeThreadId)
  const { all, shown, snapshot } = useVisibleThreads(controller)
  const actions = useCommentActions(controller)
  const [pin, setPin] = useState(true)

  // While the list is open it is kept fresh. Opening it shows the pins and, on a desktop screen, starts comment mode: the next click
  // on a page is a comment. Closing it there puts everything away; on a small screen the sheet is only a list, and the pins stay.
  useEffect(() => controller.watch(), [controller])
  useEffect(() => {
    setCommentPins(editor, true)
    if (!editor.state.ui.compact) setCommentMode(editor, true)
    return () => {
      if (editor.state.ui.compact) return
      setCommentMode(editor, false)
      setCommentPins(editor, false)
    }
  }, [editor])

  const pageNumber = (id: string | null): number | null => {
    const i = id ? doc.pages.findIndex((p) => p.id === id) : -1
    return i < 0 ? null : i + 1
  }

  const post = async (body: string): Promise<void | false> => {
    if (!(await ensureCommenter(editor, controller))) return false
    const at = pin && selection.ids.length > 0 && selection.bounds ? roundPoint(selection.bounds.x + selection.bounds.width / 2, selection.bounds.y + selection.bounds.height / 2) : { x: null, y: null }
    await controller.create({ body, page_id: selection.pageId ?? activePageId, ...at })
    editor.announce(t.comments.announce.added)
  }

  const open = shown.filter((th) => !th.root.resolved)
  const resolved = shown.filter((th) => th.root.resolved)
  const card = (th: Thread): React.ReactNode => <ThreadCard key={th.root.id} thread={th} actions={actions} active={active === th.root.id} pageNumber={pageNumber(th.root.page_id)} />
  const loading = snapshot.status === 'idle' || snapshot.status === 'loading'
  const failed = snapshot.status === 'error'

  return (
    <div className={styles.panel} data-testid="comments-panel">
      <div className={styles.modeRow}>
        <Button
          size="sm"
          variant={mode ? 'primary' : 'default'}
          pressed={mode}
          icon={<MapPin size={14} aria-hidden="true" />}
          data-testid="comment-mode"
          onClick={() => {
            if (mode) {
              setCommentMode(editor, false)
              return
            }
            setCommentMode(editor, true)
            if (compact) close()
          }}
        >
          {mode ? t.comments.mode.stop : t.comments.mode.start}
        </Button>
      </div>
      <p className={styles.help}>{t.comments.mode.help}</p>
      <Switch label={t.comments.pins.show} checked={pinsOn} onChange={(on) => setCommentPins(editor, on)} />

      <CommentComposer placeholder={t.comments.placeholder} submitLabel={t.comments.post} testId="comment-new" onSubmit={post}>
        {selection.ids.length > 0 && !readOnly ? (
          <label className={styles.pin}>
            <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
            {t.comments.pinToSelection}
          </label>
        ) : null}
      </CommentComposer>

      {all.length > 0 ? <Filters counts={countThreads(all, snapshot.viewer ?? null)} signedIn={!!snapshot.viewer} /> : null}

      {failed ? (
        <div className={styles.errorBox} role="alert" data-testid="comments-error">
          <span>{t.comments.loadFailed}</span>
          <Button size="sm" variant="soft" onClick={() => void controller.refresh()} data-testid="comments-retry">
            {t.comments.retry}
          </Button>
        </div>
      ) : null}
      {loading && !failed ? (
        <div role="status" aria-busy="true" aria-label={t.comments.loading}>
          <Skeleton height={100} radius={12} />
        </div>
      ) : null}
      {snapshot.status === 'ready' && all.length === 0 ? (
        <p className={styles.state}>
          <MessageSquarePlus size={20} aria-hidden="true" style={{ display: 'block', margin: '0 auto 6px' }} />
          {t.comments.empty}
        </p>
      ) : null}
      {snapshot.status === 'ready' && all.length > 0 && shown.length === 0 ? <p className={styles.state}>{t.comments.emptyFiltered[filter]}</p> : null}
      {open.length > 0 ? <ul className={styles.list}>{open.map(card)}</ul> : null}
      {resolved.length > 0 ? (
        <>
          <h3 className={styles.heading}>{t.comments.resolvedCount(resolved.length)}</h3>
          <ul className={styles.list}>{resolved.map(card)}</ul>
        </>
      ) : null}
    </div>
  )
}

/** Comments sidebar: threads of this design, replies, resolve, delete, filters; guests are invited to sign up. */
export function CommentsPanel({ close }: { close: () => void }) {
  const editor = useEditor()
  const controller = useCommentsController()
  const [, refresh] = useState(0)
  return editor.adapter.services.comments ? <Comments controller={controller} close={close} /> : <CommentsGate onDone={() => refresh((n) => n + 1)} />
}

