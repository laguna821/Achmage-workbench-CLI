import { X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useEditor, useEditorState } from '../context'
import { pageNotes } from '../presenter/pageProps'
import { DurationChip } from '../presenter/DurationChip'
import { NOTES_MAX_LENGTH } from '../presenter/timing'
import { t } from '../strings'
import { IconButton } from '../ui/Button'
import { setNotesOpen, useNotesOpen } from './notesVisibility'
import styles from './Notes.module.css'

/** How long typing may pause before the text is written to the document (it is also written on blur and on leaving). */
const COMMIT_DELAY_MS = 250

interface NotesFieldProps {
  pageId: string
  label: string
  readOnly: boolean
}

/**
 * The text area of one page's notes. It keeps what is typed in its own state and writes it to the document through
 * `pages.setNotes` (one undo step per typing burst); a change that arrives from elsewhere (undo, a collaborator) is
 * adopted unless there is typing of our own that has not been written yet.
 */
function NotesField({ pageId, label, readOnly }: NotesFieldProps) {
  const editor = useEditor()
  const value = useEditorState((s) => {
    const page = s.doc.pages.find((p) => p.id === pageId)
    return page ? pageNotes(page) : ''
  })
  const [text, setText] = useState(value)
  const [synced, setSynced] = useState(value)
  const [dirty, setDirty] = useState(false)
  const pending = useRef<string | null>(null)
  const timer = useRef(0)
  const counterId = useId()

  if (value !== synced) {
    setSynced(value)
    if (!dirty) setText(value)
  }

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    const next = pending.current
    if (next === null) return
    pending.current = null
    editor.pages.setNotes(pageId, next)
    setDirty(false)
  }, [editor, pageId])

  // The field is keyed by page: leaving the page (or closing the bar, or the tab) writes what is still waiting.
  useEffect(() => {
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = e.target.value
    setText(next)
    setDirty(true)
    pending.current = next
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, COMMIT_DELAY_MS)
  }

  if (readOnly) {
    return value === '' ? (
      <p className={styles.empty} data-testid="ed-notes-empty">
        {t.notes.empty}
      </p>
    ) : (
      <textarea className={styles.text} value={value} readOnly aria-readonly="true" aria-label={t.notes.forPage(label)} data-testid="ed-notes-text" />
    )
  }

  const atLimit = text.length >= NOTES_MAX_LENGTH
  return (
    <div className={styles.field}>
      <textarea
        className={styles.text}
        value={text}
        maxLength={NOTES_MAX_LENGTH}
        placeholder={t.notes.placeholder}
        aria-label={t.notes.forPage(label)}
        aria-describedby={counterId}
        spellCheck
        data-testid="ed-notes-text"
        onChange={onChange}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
      />
      <span id={counterId} className={styles.counter} data-full={atLimit || undefined} aria-label={t.notes.counterLabel(text.length, NOTES_MAX_LENGTH)} data-testid="ed-notes-counter">
        {t.notes.counter(text.length, NOTES_MAX_LENGTH)}
      </span>
      <span className={styles.sr} role="status">
        {atLimit ? t.notes.limit(NOTES_MAX_LENGTH) : ''}
      </span>
    </div>
  )
}

/** The speaker notes of the active page, under the workspace. Read-only (and without the empty text area) in view-only links. */
function NotesBar() {
  const editor = useEditor()
  const pageId = useEditorState((s) => s.activePageId)
  const index = useEditorState((s) => s.doc.pages.findIndex((p) => p.id === s.activePageId))
  const name = useEditorState((s) => s.doc.pages.find((p) => p.id === s.activePageId)?.name)
  const readOnly = useEditorState((s) => s.readOnly)
  const label = name?.trim() || t.workspace.page(Math.max(0, index) + 1)
  return (
    <section className={styles.bar} aria-label={t.notes.region} data-testid="ed-notes">
      <header className={styles.head}>
        <h2 className={styles.title}>{t.notes.title}</h2>
        <span className={styles.page} data-testid="ed-notes-page">
          {label}
        </span>
        <DurationChip pageId={pageId} />
        {readOnly ? <span className={styles.viewOnly}>{t.notes.viewOnly}</span> : null}
        <span className={styles.spacer} />
        <IconButton label={t.notes.close} size="sm" onClick={() => setNotesOpen(editor, false)} data-testid="ed-notes-close">
          <X size={16} />
        </IconButton>
      </header>
      <NotesField key={pageId} pageId={pageId} label={label} readOnly={readOnly} />
    </section>
  )
}

/** Renders the notes bar while it is switched on (the Notes button of the pages pill, the More menu or `Shift+N`). */
export function NotesHost() {
  return useNotesOpen() ? <NotesBar /> : null
}
