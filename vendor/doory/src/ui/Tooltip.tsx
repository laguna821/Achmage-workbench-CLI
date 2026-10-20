import { cloneElement, useEffect, useId, useState, type FocusEvent, type MouseEvent, type ReactElement, type ReactNode, type Ref } from 'react'
import { Portal } from './Portal'
import { useFloatingPosition, type Placement } from './position'
import styles from './Tooltip.module.css'

interface ChildProps {
  'aria-describedby'?: string
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onBlur?: (event: FocusEvent<HTMLElement>) => void
  ref?: Ref<HTMLElement>
}

export interface TooltipProps {
  content: ReactNode
  children: ReactElement<ChildProps>
  placement?: Placement
  /** Delay before showing on hover (focus shows immediately). */
  delay?: number
}

export function Tooltip({ content, children, placement = 'top', delay = 350 }: TooltipProps) {
  const [hovered, setHovered] = useState(false)
  const [hoverElapsed, setHoverElapsed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [escaped, setEscaped] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const id = useId()
  const open = !escaped && (focused || (hovered && hoverElapsed))
  const position = useFloatingPosition(anchor, node, open, placement, 8)

  useEffect(() => {
    if (!hovered) return undefined
    const timer = window.setTimeout(() => setHoverElapsed(true), delay)
    return () => {
      window.clearTimeout(timer)
      setHoverElapsed(false)
    }
  }, [hovered, delay])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEscaped(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const props = children.props
  return (
    <>
      {cloneElement(children, {
        'aria-describedby': open ? id : props['aria-describedby'],
        onMouseEnter: (event) => {
          props.onMouseEnter?.(event)
          setHovered(true)
        },
        onMouseLeave: (event) => {
          props.onMouseLeave?.(event)
          setHovered(false)
          setEscaped(false)
        },
        onFocus: (event) => {
          props.onFocus?.(event)
          setFocused(true)
        },
        onBlur: (event) => {
          props.onBlur?.(event)
          setFocused(false)
          setEscaped(false)
        },
        ref: setAnchor,
      })}
      {open ? (
        <Portal>
          <div
            ref={setNode}
            id={id}
            role="tooltip"
            className={styles.tooltip}
            style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
          >
            {content}
          </div>
        </Portal>
      ) : null}
    </>
  )
}
