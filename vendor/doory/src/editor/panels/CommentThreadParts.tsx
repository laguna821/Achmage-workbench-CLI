/** A thread as the sidebar card and the card next to a pin show it: its comments, what can be done with it, the reply box. */
import { Check, RotateCcw } from 'lucide-react'
import { t } from '../strings'
import { Button } from '../ui/Button'
import { CommentComposer, CommentEntry, DeleteControl } from './CommentParts'
import type { Thread } from './commentOps'
import type { CommentActions } from './commentsUi'
import styles from './Comments.module.css'

interface PartProps {
  thread: Thread
  actions: CommentActions
  /** Test ids start with this: `comment` in the sidebar, `pin` next to a pin. */
  idPrefix: string
}

/** The first comment and the replies, oldest first. Replies the viewer wrote (or any, for the owner) can be deleted one by one. */
export function ThreadEntries({ thread, actions, idPrefix }: PartProps) {
  const { root, replies } = thread
  return (
    <>
      <div className={styles.rootEntry}>
        <CommentEntry comment={root} pending={actions.isPending(root.id)} testId={`${idPrefix}-entry`} />
        {root.resolved ? <span className={styles.resolvedTag}>{t.comments.resolvedTag}</span> : null}
      </div>
      {replies.length > 0 ? (
        <div className={styles.replies}>
          {replies.map((reply) => (
            <CommentEntry key={reply.id} comment={reply} pending={actions.isPending(reply.id)} onDelete={actions.rights(reply).remove && !actions.isPending(reply.id) ? () => actions.remove(reply.id) : undefined} deleteLabel={t.comments.deleteReply} testId={`${idPrefix}-entry`} />
          ))}
        </div>
      ) : null}
    </>
  )
}

interface ActionsProps extends PartProps {
  /** Shows the "Reply" button (the sidebar keeps its reply box closed until asked). */
  onReply?: () => void
}

/** Resolve / reopen, and delete the thread. The buttons the viewer may not use are not there. */
export function ThreadActions({ thread, actions, idPrefix, onReply }: ActionsProps) {
  const { root } = thread
  const rights = actions.rights(root)
  const pending = actions.isPending(root.id)
  return (
    <div className={styles.actions}>
      {onReply && !pending ? (
        <Button size="sm" variant="ghost" onClick={onReply} data-testid={`${idPrefix}-reply-open`}>
          {t.comments.reply}
        </Button>
      ) : null}
      {rights.resolve && !pending ? (
        <Button size="sm" variant="ghost" icon={root.resolved ? <RotateCcw size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />} onClick={() => actions.resolve(root.id, !root.resolved)} data-testid={`${idPrefix}-resolve`}>
          {root.resolved ? t.comments.reopen : t.comments.resolve}
        </Button>
      ) : null}
      <span className={styles.grow} />
      {rights.remove && !pending ? <DeleteControl label={t.comments.delete} confirmLabel={t.comments.deleteConfirm} onConfirm={() => actions.remove(root.id)} confirmTestId={`${idPrefix}-delete-confirm`} /> : null}
    </div>
  )
}

interface ReplyProps extends PartProps {
  autoFocus?: boolean
  /** Called after the reply was sent. */
  onSent?: () => void
  onCancel?: () => void
}

export function ReplyComposer({ thread, actions, idPrefix, autoFocus = false, onSent, onCancel }: ReplyProps) {
  return (
    <CommentComposer
      placeholder={t.comments.replyPlaceholder}
      submitLabel={t.comments.reply}
      testId={`${idPrefix}-reply`}
      autoFocus={autoFocus}
      disabled={actions.isPending(thread.root.id)}
      onCancel={onCancel}
      onSubmit={async (body) => {
        const sent = await actions.reply(thread.root.id, body)
        if (sent === false) return false
        onSent?.()
      }}
    />
  )
}
