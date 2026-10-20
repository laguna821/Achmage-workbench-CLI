import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePortalRoot } from '../context'
import { formatShortcut } from '../shortcuts'
import styles from './Menu.module.css'

export interface MenuItem {
  id: string
  label?: string
  icon?: ReactNode
  shortcut?: string
  /** Muted note at the right edge (format hints such as "Smaller", "Transparent"). */
  hint?: string
  onSelect?: () => void
  disabled?: boolean
  /** Shows a check mark (toggle items). */
  checked?: boolean
  danger?: boolean
  separator?: boolean
  /** A small label over the items that follow it (not focusable). */
  heading?: boolean
}

interface MenuProps {
  items: MenuItem[]
  label: string
  /** Screen position (context menu) or an anchor element (dropdown). */
  at?: { x: number; y: number }
  anchorRef?: RefObject<HTMLElement | null>
  onClose: () => void
}

/** Keyboard-navigable menu (arrow keys, Home/End, Enter, Escape). */
export function Menu({ items, label, at, anchorRef, onClose }: MenuProps) {
  const root = usePortalRoot()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const panel = ref.current
    if (!panel) return
    const r = panel.getBoundingClientRect()
    let left = at?.x ?? 0
    let top = at?.y ?? 0
    if (anchorRef?.current) {
      const a = anchorRef.current.getBoundingClientRect()
      left = a.left
      top = a.bottom + 6
    }
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8))
    top = Math.max(8, Math.min(top, window.innerHeight - r.height - 8))
    setPos({ left, top })
  }, [at, anchorRef, items.length])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true })
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target) || anchorRef?.current?.contains(target)) return
      onClose()
    }
    // Escape closes the menu even when focus is still on the control that opened it.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || ref.current?.contains(document.activeElement)) return
      e.stopPropagation()
      onClose()
      anchorRef?.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, anchorRef])

  const move = (dir: 1 | -1 | 'first' | 'last'): void => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])]
    if (nodes.length === 0) return
    const current = nodes.indexOf(document.activeElement as HTMLElement)
    let next = 0
    if (dir === 'first') next = 0
    else if (dir === 'last') next = nodes.length - 1
    else next = (current + dir + nodes.length) % nodes.length
    nodes[next].focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        move(-1)
        break
      case 'Home':
        e.preventDefault()
        move('first')
        break
      case 'End':
        e.preventDefault()
        move('last')
        break
      case 'Escape':
      case 'Tab':
        e.preventDefault()
        onClose()
        anchorRef?.current?.focus()
        break
    }
  }

  if (!root) return null
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={styles.menu}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, opacity: pos ? undefined : 0 }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} role="separator" className={styles.sep} />
        ) : item.heading ? (
          <div key={item.id} role="presentation" className={styles.heading}>
            {item.label}
          </div>
        ) : (
          <button
            key={item.id}
            type="button"
            role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={item.checked}
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            className={`${styles.item} ${item.danger ? styles.danger : ''}`}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onSelect?.()
            }}
          >
            <span className={styles.icon}>{item.checked ? <CheckMark /> : item.icon}</span>
            <span className={styles.label}>{item.label}</span>
            {item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
            {item.shortcut ? <kbd className={styles.kbd}>{formatShortcut(item.shortcut)}</kbd> : null}
          </button>
        ),
      )}
    </div>,
    root,
  )
}

function CheckMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  )
}
