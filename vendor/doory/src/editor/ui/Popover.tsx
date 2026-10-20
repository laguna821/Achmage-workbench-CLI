import {
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { usePortalRoot } from '../context'
import styles from './Popover.module.css'

/** Id of the popover a nested popover was opened from (portals put them side by side in the DOM). */
const ParentPopover = createContext<string | null>(null)

/** True when `target` sits in a popover opened from popover `id`, at any depth. */
function inChildOf(target: Node, id: string): boolean {
  let el = (target instanceof Element ? target : target.parentElement)?.closest<HTMLElement>('[data-popover]')
  while (el) {
    const parent = el.dataset.popoverParent
    if (parent === id) return true
    el = parent ? document.querySelector<HTMLElement>(`[data-popover="${CSS.escape(parent)}"]`) : null
  }
  return false
}

export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top' | 'right-start' | 'left-start'

interface PopoverProps {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
  placement?: Placement
  /** Accessible name of the floating panel. */
  label: string
  children: ReactNode
  width?: number | string
  className?: string
  /** Do not close when the pointer goes down inside these elements (e.g. a nested picker). */
  keepOpenRefs?: RefObject<HTMLElement | null>[]
  /** `plain` has no padding: used by toolbar popovers and drawers. */
  variant?: 'default' | 'plain'
  /**
   * Puts a transparent click-catcher under the panel : the click that
   * dismisses the panel does nothing else, and nothing behind the panel reacts while it is open.
   */
  cover?: boolean
  /** Distance between the anchor and the panel in px. */
  gap?: number
  /** Moves focus into the panel when it opens (keyboard users), without stealing it from the canvas for pointer users. */
  focusOnOpen?: boolean
}

const MARGIN = 8

function place(anchor: DOMRect, panel: DOMRect, placement: Placement, gap: number): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = anchor.left
  let top = anchor.bottom + gap
  switch (placement) {
    case 'bottom-end':
      left = anchor.right - panel.width
      break
    case 'bottom':
      left = anchor.left + anchor.width / 2 - panel.width / 2
      break
    case 'top-start':
      top = anchor.top - panel.height - gap
      break
    case 'top':
      left = anchor.left + anchor.width / 2 - panel.width / 2
      top = anchor.top - panel.height - gap
      break
    case 'right-start':
      left = anchor.right + gap
      top = anchor.top
      break
    case 'left-start':
      left = anchor.left - panel.width - gap
      top = anchor.top
      break
    default:
      break
  }
  // Flip vertically if it would overflow, then clamp inside the viewport.
  if (top + panel.height > vh - MARGIN && anchor.top - panel.height - gap > MARGIN && placement.startsWith('bottom')) top = anchor.top - panel.height - gap
  left = Math.max(MARGIN, Math.min(left, vw - panel.width - MARGIN))
  top = Math.max(MARGIN, Math.min(top, vh - panel.height - MARGIN))
  return { left, top }
}

/** Anchored floating panel: closes on outside click / Escape, restores focus to the anchor. */
export function Popover({ open, onClose, anchorRef, placement = 'bottom-start', label, children, width, className, keepOpenRefs, variant = 'default', cover = false, gap = 6, focusOnOpen = false }: PopoverProps) {
  const root = usePortalRoot()
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const parentId = useContext(ParentPopover)

  /** Positions the panel next to its anchor. Done on the DOM node so measuring never triggers a render. */
  const reposition = useCallback(() => {
    const a = anchorRef.current
    const p = panelRef.current
    if (!a || !p) return
    const pos = place(a.getBoundingClientRect(), p.getBoundingClientRect(), placement, gap)
    p.style.left = `${pos.left}px`
    p.style.top = `${pos.top}px`
    p.dataset.placed = 'true'
  }, [anchorRef, placement, gap])

  useLayoutEffect(() => {
    if (open) reposition()
  }, [open, reposition, children])

  useEffect(() => {
    if (!open || !focusOnOpen) return
    const panel = panelRef.current
    if (!panel) return
    const first = panel.querySelector<HTMLElement>('input:not([type="hidden"]), button:not(:disabled), [tabindex="0"], select, textarea')
    ;(first ?? panel).focus({ preventScroll: true })
  }, [open, focusOnOpen])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      if (keepOpenRefs?.some((r) => r.current?.contains(target))) return
      if (inChildOf(target, id)) return
      if (cover) {
        // The dismissing click belongs to the popover alone: nothing behind it may react.
        e.preventDefault()
        e.stopPropagation()
        let timer = 0
        const cleanup = (): void => {
          window.removeEventListener('click', swallow, true)
          window.removeEventListener('pointerdown', cleanup, true)
          window.clearTimeout(timer)
        }
        function swallow(ev: Event): void {
          ev.preventDefault()
          ev.stopPropagation()
          cleanup()
        }
        window.addEventListener('click', swallow, true)
        // A new gesture means the click of this one will never arrive (its target went away): stop swallowing.
        window.addEventListener('pointerdown', cleanup, true)
        timer = window.setTimeout(cleanup, 400)
      }
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        anchorRef.current?.focus()
      }
    }
    const onScroll = (): void => reposition()
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, onClose, anchorRef, reposition, keepOpenRefs, cover, id])

  if (!open || !root) return null
  return createPortal(
    <>
      {cover ? <div className={styles.cover} aria-hidden="true" /> : null}
      <div
        ref={panelRef}
        id={id}
        data-popover={id}
        data-popover-parent={parentId ?? undefined}
        role="dialog"
        aria-label={label}
        className={`${styles.panel} ${variant === 'plain' ? styles.plain : ''} ${className ?? ''}`}
        style={{ width }}
        tabIndex={-1}
      >
        <ParentPopover.Provider value={id}>{children}</ParentPopover.Provider>
      </div>
    </>,
    root,
  )
}

interface PopoverButtonProps {
  label: string
  /** Renders the trigger; receives props to spread on a button. */
  trigger: (props: { ref: RefObject<HTMLButtonElement | null>; onClick: () => void; 'aria-haspopup': 'dialog'; 'aria-expanded': boolean }) => ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  placement?: Placement
  width?: number | string
  className?: string
}

/** Trigger + popover pair with its own open state. */
export function PopoverButton({ label, trigger, children, placement, width, className }: PopoverButtonProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      {trigger({ ref, onClick: () => setOpen((o) => !o), 'aria-haspopup': 'dialog', 'aria-expanded': open })}
      <Popover open={open} onClose={close} anchorRef={ref} label={label} placement={placement} width={width} className={className}>
        {typeof children === 'function' ? children(close) : children}
      </Popover>
    </>
  )
}
