import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import styles from './InlineRename.module.css'

export interface InlineRenameProps {
  value: string
  label: string
  maxLength?: number
  onCommit(next: string): void
  onCancel(): void
}

/** Text input that commits on Enter/blur and cancels on Escape. */
export function InlineRename({ value, label, maxLength = 120, onCommit, onCancel }: InlineRenameProps) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  function commit() {
    if (done.current) return
    done.current = true
    onCommit(draft)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      done.current = true
      onCancel()
    }
  }

  return <input ref={ref} className={styles.input} aria-label={label} value={draft} maxLength={maxLength} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
}
