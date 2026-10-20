import { useEffect, useId, useRef, useState } from 'react'
import { I } from '../chrome/icons'
import styles from './Sticker.module.css'

/** The pill-shaped search field of the docked libraries (Stickers, Templates…), with its clear button. */
export function LibrarySearch({ value, onChange, placeholder, clearLabel, testId }: { value: string; onChange: (value: string) => void; placeholder: string; clearLabel: string; testId: string }) {
  return (
    <div className={styles.search}>
      <span className={styles.searchIcon}>{I.search}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} data-testid={testId} />
      {value ? (
        <button type="button" className={styles.clear} onClick={() => onChange('')} title={clearLabel} aria-label={clearLabel}>
          {I.xClear}
        </button>
      ) : null}
    </div>
  )
}

export type CategoryEntry = { kind: 'group'; id: string; label: string } | { kind: 'option'; id: string; label: string; count?: number }

interface CategoryMenuProps {
  /** Accessible name of the list (also the prefix of the button's name). */
  name: string
  /** Text of the closed button. */
  label: string
  entries: readonly CategoryEntry[]
  activeId: string
  onSelect: (id: string) => void
  disabled?: boolean
  testId: string
}

/** The category dropdown: a pill button that opens a list; Escape closes only the list, ↑/↓ move through it. */
export function CategoryMenu({ name, label, entries, activeId, onSelect, disabled, testId }: CategoryMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    if (nodes.length === 0) return
    e.preventDefault()
    const i = nodes.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % nodes.length : (i - 1 + nodes.length) % nodes.length
    nodes[next].focus()
  }

  return (
    <div className={styles.category} ref={ref} onKeyDown={onKeyDown}>
      <button type="button" className={`${styles.categoryBtn} ${open ? styles.open : ''}`} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-label={`${name}: ${label}`} data-testid={testId} onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        {I.chevronDown}
      </button>
      {open ? (
        <ul id={menuId} className={styles.menu} role="listbox" aria-label={name}>
          {entries.map((entry) =>
            entry.kind === 'group' ? (
              <li key={entry.id} role="presentation" className={styles.group}>
                {entry.label}
              </li>
            ) : (
              <li key={entry.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={entry.id === activeId}
                  className={entry.id === activeId ? styles.active : ''}
                  autoFocus={entry.id === activeId}
                  onClick={() => {
                    onSelect(entry.id)
                    setOpen(false)
                  }}
                >
                  <span>{entry.label}</span>
                  {entry.count !== undefined ? <span className={styles.count}>{entry.count}</span> : null}
                </button>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  )
}
