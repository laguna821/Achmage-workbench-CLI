import { cloneElement, createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from 'react'
import { cx } from '@/lib/cx'
import { FloatingPanel } from './FloatingPanel'
import type { Placement } from './position'
import styles from './Menu.module.css'

interface MenuContextValue {
  close(options?: { restoreFocus?: boolean }): void
}

const MenuContext = createContext<MenuContextValue | null>(null)

export interface MenuTriggerProps {
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string | undefined
  onClick(): void
  onKeyDown(event: KeyboardEvent<HTMLElement>): void
  ref: Ref<HTMLElement>
}

export interface MenuProps {
  trigger: ReactElement<Partial<MenuTriggerProps>>
  label: string
  children: ReactNode
  placement?: Placement
  className?: string
}

const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"])'

export function Menu({ trigger, label, children, placement = 'bottom-start', className }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', timer: 0 })
  const id = useId()
  const [focusOnOpen, setFocusOnOpen] = useState<'first' | 'last'>('first')

  const items = useCallback(() => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []), [])

  const close = useCallback(
    (options?: { restoreFocus?: boolean }) => {
      setOpen(false)
      if (options?.restoreFocus !== false) anchor?.focus({ preventScroll: true })
    },
    [anchor],
  )

  useEffect(() => {
    if (!open) return undefined
    const frame = requestAnimationFrame(() => {
      const list = items()
      const target = focusOnOpen === 'last' ? list[list.length - 1] : list[0]
      ;(target ?? panelRef.current)?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, items, focusOnOpen])

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    const index = list.findIndex((el) => el === document.activeElement)
    const move = (next: number) => {
      event.preventDefault()
      list[(next + list.length) % list.length]?.focus()
    }
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1)
        return
      case 'ArrowUp':
        move(index < 0 ? list.length - 1 : index - 1)
        return
      case 'Home':
        move(0)
        return
      case 'End':
        move(list.length - 1)
        return
      case 'Tab':
        close({ restoreFocus: false })
        return
      default:
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      window.clearTimeout(typeahead.current.timer)
      typeahead.current.text += event.key.toLowerCase()
      typeahead.current.timer = window.setTimeout(() => {
        typeahead.current.text = ''
      }, 600)
      const text = typeahead.current.text
      const ordered = [...list.slice(index + 1), ...list.slice(0, index + 1)]
      const match = ordered.find((el) => (el.textContent ?? '').trim().toLowerCase().startsWith(text))
      if (match) {
        event.preventDefault()
        match.focus()
      }
    }
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setFocusOnOpen(event.key === 'ArrowUp' ? 'last' : 'first')
      setOpen(true)
    }
  }

  return (
    <MenuContext.Provider value={{ close }}>
      {cloneElement(trigger, {
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        onClick: () => {
          setFocusOnOpen('first')
          setOpen(!open)
        },
        onKeyDown: onTriggerKeyDown,
        ref: setAnchor,
      })}
      <FloatingPanel
        ref={panelRef}
        open={open}
        anchor={anchor}
        placement={placement}
        onDismiss={(reason) => close({ restoreFocus: reason === 'escape' })}
        id={id}
        role="menu"
        aria-label={label}
        className={cx(styles.menu, className)}
        onKeyDown={onPanelKeyDown}
      >
        {children}
      </FloatingPanel>
    </MenuContext.Provider>
  )
}

export interface MenuItemProps {
  children: ReactNode
  onSelect?: () => void
  icon?: ReactNode
  shortcut?: ReactNode
  danger?: boolean
  disabled?: boolean
  /** For checkable items (e.g. the current sort order). */
  checked?: boolean
}

export function MenuItem({ children, onSelect, icon, shortcut, danger, disabled, checked }: MenuItemProps) {
  const ctx = useContext(MenuContext)
  const role = checked === undefined ? 'menuitem' : 'menuitemradio'
  const activate = () => {
    if (disabled) return
    ctx?.close()
    onSelect?.()
  }
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={cx(styles.item, danger && styles.danger)}
      data-checked={checked || undefined}
      onClick={activate}
    >
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.text}>{children}</span>
      {shortcut ? <span className={styles.shortcut}>{shortcut}</span> : null}
    </button>
  )
}

export function MenuSeparator() {
  return <hr role="separator" className={styles.separator} />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div role="presentation" className={styles.label}>
      {children}
    </div>
  )
}
