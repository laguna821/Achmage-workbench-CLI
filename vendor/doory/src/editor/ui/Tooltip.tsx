import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePortalRoot } from '../context'
import { formatShortcut } from '../shortcuts'
import styles from './Tooltip.module.css'

interface TooltipProps {
  label: string
  shortcut?: string
  /** Where the tip appears relative to the control. */
  side?: 'top' | 'bottom' | 'right' | 'left'
  children: ReactNode
  disabled?: boolean
}

const SHOW_DELAY = 450

/** Hover/focus label with an optional shortcut hint. Children keep their own aria-label. */
export function Tooltip({ label, shortcut, side = 'bottom', children, disabled }: TooltipProps) {
  const root = usePortalRoot()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setPos(null)
  }, [])

  const show = useCallback(() => {
    if (disabled || timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      const el = wrapRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const x = side === 'right' ? r.right + 8 : side === 'left' ? r.left - 8 : r.left + r.width / 2
      const y = side === 'top' ? r.top - 8 : side === 'bottom' ? r.bottom + 8 : r.top + r.height / 2
      setPos({ x, y })
    }, SHOW_DELAY)
  }, [disabled, side])

  useEffect(() => hide, [hide])

  return (
    <span ref={wrapRef} className={styles.wrap} onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide} onFocus={show} onBlur={hide}>
      {children}
      {pos && root
        ? createPortal(
            <span role="tooltip" className={`${styles.tip} ${styles[side]}`} style={{ left: pos.x, top: pos.y }}>
              {label}
              {shortcut ? <kbd className={styles.kbd}>{formatShortcut(shortcut)}</kbd> : null}
            </span>,
            root,
          )
        : null}
    </span>
  )
}
