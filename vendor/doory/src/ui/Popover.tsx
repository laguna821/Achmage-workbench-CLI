import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react'
import { cx } from '@/lib/cx'
import { FloatingPanel } from './FloatingPanel'
import { getFocusable, useControllableState } from './hooks'
import type { Placement } from './position'
import styles from './Popover.module.css'

export interface PopoverTriggerProps {
  'aria-haspopup': 'dialog'
  'aria-expanded': boolean
  'aria-controls': string | undefined
  onClick(): void
  ref: Ref<HTMLElement>
}

export interface PopoverProps {
  /** The element that toggles the popover. It receives aria + onClick + ref props. */
  trigger: ReactElement<Partial<PopoverTriggerProps>>
  label: string
  children: ReactNode | ((close: () => void) => ReactNode)
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  placement?: Placement
  className?: string
}

export function Popover({ trigger, label, children, open, defaultOpen = false, onOpenChange, placement = 'bottom-start', className }: PopoverProps) {
  const [isOpen, setOpen] = useControllableState<boolean>(open, defaultOpen, onOpenChange)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const close = useCallback(() => setOpen(false), [setOpen])

  useEffect(() => {
    if (!isOpen) return undefined
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const first = getFocusable(panel)[0]
      ;(first ?? panel).focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [isOpen])

  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !isOpen) anchor?.focus({ preventScroll: true })
    wasOpen.current = isOpen
  }, [isOpen, anchor])

  return (
    <>
      {cloneElement(trigger, {
        'aria-haspopup': 'dialog',
        'aria-expanded': isOpen,
        'aria-controls': isOpen ? id : undefined,
        onClick: () => setOpen(!isOpen),
        ref: setAnchor,
      })}
      <FloatingPanel ref={panelRef} open={isOpen} anchor={anchor} placement={placement} onDismiss={close} id={id} role="dialog" aria-label={label} className={cx(styles.popover, className)}>
        {typeof children === 'function' ? children(close) : children}
      </FloatingPanel>
    </>
  )
}
