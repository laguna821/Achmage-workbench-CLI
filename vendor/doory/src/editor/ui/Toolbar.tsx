import { type ReactNode, useCallback, useLayoutEffect, useRef } from 'react'
import styles from './Toolbar.module.css'

const ITEM = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), [role="slider"], [data-roving]'

interface ToolbarProps {
  label: string
  children: ReactNode
  className?: string
  orientation?: 'horizontal' | 'vertical'
}

/**
 * `role=toolbar` with roving tabindex: one stop in the tab order, arrow keys move between controls.
 * Popover content lives in a portal, so it is never part of the roving set.
 */
export function Toolbar({ label, children, className, orientation = 'horizontal' }: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null)
  const active = useRef<HTMLElement | null>(null)

  const items = useCallback((): HTMLElement[] => [...(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])].filter((el) => el.offsetParent !== null || el === document.activeElement), [])

  useLayoutEffect(() => {
    const all = items()
    const current = active.current && all.includes(active.current) ? active.current : all[0]
    for (const el of all) el.tabIndex = el === current ? 0 : -1
    active.current = current ?? null
  })

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (target as HTMLInputElement).type !== 'range') return
    const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
    const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
    if (e.key !== prev && e.key !== next && e.key !== 'Home' && e.key !== 'End') return
    const all = items()
    const index = all.indexOf(target)
    if (index < 0) return
    e.preventDefault()
    let to = index
    if (e.key === next) to = (index + 1) % all.length
    else if (e.key === prev) to = (index - 1 + all.length) % all.length
    else if (e.key === 'Home') to = 0
    else to = all.length - 1
    all[to].focus()
  }

  const onFocus = (e: React.FocusEvent): void => {
    const el = e.target as HTMLElement
    if (items().includes(el)) {
      for (const it of items()) it.tabIndex = it === el ? 0 : -1
      active.current = el
    }
  }

  return (
    <div ref={ref} role="toolbar" aria-label={label} aria-orientation={orientation} className={`${styles.toolbar} ${className ?? ''}`} onKeyDown={onKeyDown} onFocus={onFocus}>
      {children}
    </div>
  )
}

export function ToolbarSeparator() {
  return <span role="separator" aria-orientation="vertical" className={styles.sep} />
}
