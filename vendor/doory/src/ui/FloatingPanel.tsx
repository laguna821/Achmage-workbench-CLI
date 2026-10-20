import { useState, type ReactNode, type Ref } from 'react'
import { cx } from '@/lib/cx'
import { useMergedRef, useOutsideClick } from './hooks'
import { Portal } from './Portal'
import { useFloatingPosition, type Placement } from './position'
import styles from './FloatingPanel.module.css'

export interface FloatingPanelProps {
  open: boolean
  anchor: HTMLElement | null
  placement?: Placement
  /** Called on ESC or an outside pointer press. */
  onDismiss(reason: 'escape' | 'outside'): void
  id?: string
  role?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  matchAnchorWidth?: boolean
  className?: string
  children: ReactNode
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
  ref?: Ref<HTMLDivElement>
}

/** Fixed-position surface anchored to an element: placement, flipping, ESC + outside-press dismissal. */
export function FloatingPanel({ open, anchor, placement = 'bottom-start', onDismiss, id, role, matchAnchorWidth, className, children, onKeyDown, ref, ...aria }: FloatingPanelProps) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const mergedRef = useMergedRef<HTMLDivElement>(setNode, ref)
  const position = useFloatingPosition(anchor, node, open, placement)
  useOutsideClick([node, anchor], () => onDismiss('outside'), open)

  if (!open) return null
  return (
    <Portal>
      <div
        ref={mergedRef}
        id={id}
        role={role}
        className={cx(styles.panel, className)}
        style={{
          top: position?.top ?? 0,
          left: position?.left ?? 0,
          minWidth: matchAnchorWidth ? position?.minWidth : undefined,
          visibility: position ? 'visible' : 'hidden',
        }}
        data-placement={position?.placement}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onDismiss('escape')
            return
          }
          onKeyDown?.(event)
        }}
        {...aria}
      >
        {children}
      </div>
    </Portal>
  )
}
