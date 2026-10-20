import { useState } from 'react'
import { useIsoLayoutEffect } from './hooks'

export type Placement =
  | 'bottom-start'
  | 'bottom'
  | 'bottom-end'
  | 'top-start'
  | 'top'
  | 'top-end'
  | 'right-start'
  | 'left-start'

export interface Position {
  top: number
  left: number
  placement: Placement
  minWidth?: number
}

const MARGIN = 8

/** Pure placement maths with viewport flipping/clamping; exported for tests. */
export function computePosition(
  anchor: DOMRect,
  content: { width: number; height: number },
  placement: Placement,
  viewport: { width: number; height: number },
  offset = 6,
): Position {
  let side: 'bottom' | 'top' | 'right' | 'left' = placement.startsWith('top')
    ? 'top'
    : placement.startsWith('right')
      ? 'right'
      : placement.startsWith('left')
        ? 'left'
        : 'bottom'
  const align = placement.endsWith('-start') ? 'start' : placement.endsWith('-end') ? 'end' : 'center'

  if (side === 'bottom' && anchor.bottom + offset + content.height > viewport.height - MARGIN && anchor.top - offset - content.height >= MARGIN) side = 'top'
  else if (side === 'top' && anchor.top - offset - content.height < MARGIN && anchor.bottom + offset + content.height <= viewport.height - MARGIN) side = 'bottom'
  else if (side === 'right' && anchor.right + offset + content.width > viewport.width - MARGIN && anchor.left - offset - content.width >= MARGIN) side = 'left'
  else if (side === 'left' && anchor.left - offset - content.width < MARGIN && anchor.right + offset + content.width <= viewport.width - MARGIN) side = 'right'

  let top: number
  let left: number
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? anchor.bottom + offset : anchor.top - offset - content.height
    left = align === 'start' ? anchor.left : align === 'end' ? anchor.right - content.width : anchor.left + anchor.width / 2 - content.width / 2
  } else {
    left = side === 'right' ? anchor.right + offset : anchor.left - offset - content.width
    top = align === 'end' ? anchor.bottom - content.height : align === 'center' ? anchor.top + anchor.height / 2 - content.height / 2 : anchor.top
  }
  left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, viewport.width - content.width - MARGIN))
  top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, viewport.height - content.height - MARGIN))
  const align2 = align === 'center' ? '' : `-${align}`
  return { top, left, placement: (side === 'bottom' && align === 'center' ? 'bottom' : `${side}${align2}`) as Placement }
}

/** Positions `content` next to `anchor` (fixed coordinates) and keeps it in sync on scroll/resize. */
export function useFloatingPosition(
  anchor: HTMLElement | null,
  content: HTMLElement | null,
  open: boolean,
  placement: Placement,
  offset = 6,
): Position | null {
  const [position, setPosition] = useState<Position | null>(null)

  useIsoLayoutEffect(() => {
    if (!open || !anchor || !content) {
      setPosition(null)
      return undefined
    }
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      const next = computePosition(
        rect,
        { width: content.offsetWidth, height: content.offsetHeight },
        placement,
        { width: window.innerWidth, height: window.innerHeight },
        offset,
      )
      setPosition({ ...next, minWidth: rect.width })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    observer?.observe(content)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      observer?.disconnect()
    }
  }, [anchor, content, open, placement, offset])

  return position
}
