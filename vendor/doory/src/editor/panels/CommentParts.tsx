/** The small pieces the comments sidebar and the cards next to the pins share: avatar, one comment, the composer, a delete button that asks first. */
import { Send, Trash2 } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import type { CommentT } from '@/types/api'
import { t } from '../strings'
import { Button, IconButton } from '../ui/Button'
import { describeCommentFailure } from './commentFailure'
import { MAX_COMMENT_LENGTH, formatWhen, initials } from './commentOps'
import styles from './Comments.module.css'

export function Avatar({ name, src, size = 26 }: { name: string; src: string | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)) }
  return (
    <span className={styles.avatar} style={style} aria-hidden="true">
      {src && !broken ? <img src={src} alt="" className={styles.avatarImage} draggable={false} onError={() => setBroken(true)} /> : initials(name)}
    </span>
  )
}

interface EntryProps {
  comment: CommentT
  pending?: boolean
  /** Shown as a small button on the right: deleting a reply. */
  onDelete?: () => void
  deleteLabel?: string
  testId?: string
}

/** One comment: avatar, who, when, the words (always text, never markup). */
export function CommentEntry({ comment, pending = false, onDelete, deleteLabel, testId }: EntryProps) {
  return (
    <div className={styles.comment} data-pending={pending || undefined} data-deletable={onDelete ? '' : undefined} data-testid={testId}>
      <Avatar name={comment.author.name} src={comment.author.avatar_url} />
      {onDelete ? (
        <span className={styles.entryAction}>
          <DeleteControl label={deleteLabel ?? t.comments.deleteReply} confirmLabel={t.comments.deleteReplyConfirm} onConfirm={onDelete} compact />
        </span>
      ) : null}
      <div className={styles.body}>
        <div className={styles.who}>
          <strong>{comment.author.name}</strong>
          <small>{pending ? t.comments.sending : <time dateTime={comment.created_at}>{formatWhen(comment.created_at)}</time>}</small>
        </div>
        <p className={styles.words}>{comment.body}</p>
      </div>
    </div>
  )
}

interface DeleteProps {
  label: string
  confirmLabel: string
  onConfirm: () => void
  /** An icon button that turns into "confirm / cancel" in place. */
  compact?: boolean
  confirmTestId?: string
}

/** Delete with one more click to confirm: the trash button becomes the question. */
export function DeleteControl({ label, confirmLabel, onConfirm, compact = false, confirmTestId }: DeleteProps) {
  const [asking, setAsking] = useState(false)
  if (asking) {
    return (
      <>
        <Button size="sm" variant="danger" onClick={onConfirm} data-testid={confirmTestId ?? 'comment-delete-confirm'}>
          {confirmLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
          {t.comments.cancel}
        </Button>
      </>
    )
  }
  return (
    <IconButton label={label} size="sm" onClick={() => setAsking(true)} className={compact ? styles.small : undefined}>
      <Trash2 size={compact ? 12 : 14} aria-hidden="true" />
    </IconButton>
  )
}

interface ComposerProps {
  placeholder: string
  submitLabel: string
  /** Rejects when the comment could not be saved: the text stays and the reason is shown. Resolves `false` for "not sent, nothing to say" (the person declined to sign in). */
  onSubmit: (body: string) => Promise<void | false>
  /** Controlled text (the draft kept in the editor store); without it the composer keeps its own. */
  value?: string
  onChange?: (body: string) => void
  /** The Cancel button, shown when `cancelLabel` is set (Esc is handled by the editor, which knows what is open). */
  onCancel?: () => void
  cancelLabel?: string
  autoFocus?: boolean
  /** Focuses the text box again whenever this changes (the spot of a comment being written moved). */
  refocusKey?: string
  disabled?: boolean
  testId: string
  children?: ReactNode
}

/** A text box with a send button. Ctrl/Cmd+Enter sends; a failure keeps the text and says why. */
export function CommentComposer({ placeholder, submitLabel, onSubmit, value, onChange, onCancel, cancelLabel, autoFocus = false, refocusKey, disabled = false, testId, children }: ComposerProps) {
  const [own, setOwn] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const alive = useRef(true)
  const body = value ?? own
  const change = (next: string): void => {
    setFailure(null)
    if (onChange) onChange(next)
    else setOwn(next)
  }

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true })
  }, [autoFocus, refocusKey])

  const send = async (): Promise<void> => {
    const text = body.trim()
    if (!text || busy || disabled) return
    setBusy(true)
    setFailure(null)
    try {
      const sent = await onSubmit(text)
      if (alive.current && sent !== false) change('')
    } catch (error) {
      if (alive.current) setFailure(describeCommentFailure(error))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
    }
  }

  const left = MAX_COMMENT_LENGTH - body.length
  return (
    <div className={styles.compose}>
      <textarea
        ref={field}
        className={styles.text}
        value={body}
        maxLength={MAX_COMMENT_LENGTH}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-invalid={failure ? true : undefined}
        disabled={disabled}
        data-testid={`${testId}-text`}
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {failure ? (
        <p className={styles.error} role="alert" data-testid={`${testId}-error`}>
          {failure}
        </p>
      ) : null}
      <div className={styles.row}>
        {children}
        <span className={styles.grow} />
        {left < 200 ? (
          <small className={styles.counter} aria-live="polite">
            {t.comments.charactersLeft(left)}
          </small>
        ) : null}
        {onCancel && cancelLabel ? (
          <Button variant="ghost" size="sm" onClick={onCancel} data-testid={`${testId}-cancel`}>
            {cancelLabel}
          </Button>
        ) : null}
        <Button variant="primary" size="sm" icon={<Send size={14} aria-hidden="true" />} disabled={!body.trim() || busy || disabled} onClick={() => void send()} data-testid={`${testId}-send`}>
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
