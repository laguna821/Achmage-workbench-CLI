import { type ReactNode, useCallback, useRef, useState } from 'react'
import { Popover, type Placement } from '../ui/Popover'
import { Tooltip } from '../ui/Tooltip'
import ed from '../chrome/ed.module.css'
import styles from './parts.module.css'

interface ToolButtonProps {
  label: string
  shortcut?: string
  pressed?: boolean
  disabled?: boolean
  danger?: boolean
  featured?: boolean
  onClick: () => void
  children: ReactNode
  testId?: string
}

/** Icon button of the contextual strip . */
export function ToolButton({ label, shortcut, pressed, disabled, danger, featured, onClick, children, testId }: ToolButtonProps) {
  return (
    <Tooltip label={label} shortcut={shortcut} disabled={disabled}>
      <button
        type="button"
        className={`${ed.toolBtn} ${pressed ? ed.active : ''} ${danger ? ed.dangerBtn : ''} ${featured ? ed.featured : ''}`}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        data-testid={testId}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  )
}

interface PopoverToolProps {
  label: string
  /** Icon or text shown on the trigger. */
  trigger: ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  placement?: Placement
  width?: number | string
  pressed?: boolean
  disabled?: boolean
  shortcut?: string
  testId?: string
  /** Render the trigger as a text button (`Placeholder`, `Remove Background`). */
  text?: boolean
  /** Popover body without the default 12 px padding (pickers, lists). */
  flush?: boolean
  /** Layout of the body: `inline` lays buttons in a row. */
  inline?: boolean
}

/** Toolbar button that opens a popover under it . */
export function PopoverTool({ label, trigger, children, placement = 'bottom', width, pressed, disabled, shortcut, testId, flush, inline }: PopoverToolProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  /** Opened with Enter / Space: focus moves into the popover. A pointer click leaves focus where it was. */
  const [keyboard, setKeyboard] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <Tooltip label={label} shortcut={shortcut} disabled={open || disabled}>
        <button
          ref={ref}
          type="button"
          className={`${ed.toolBtn} ${pressed || open ? ed.active : ''}`}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId}
          onClick={(e) => {
            setKeyboard(e.detail === 0)
            setOpen((o) => !o)
          }}
        >
          {trigger}
        </button>
      </Tooltip>
      <Popover open={open} onClose={close} anchorRef={ref} label={label} placement={placement} width={width} variant="plain" cover focusOnOpen={keyboard}>
        <div className={inline ? ed.popInline : flush ? undefined : ed.popBody} data-testid={testId ? `${testId}-pop` : undefined}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      </Popover>
    </>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={ed.propLabel}>{label}</span>
      {children}
    </div>
  )
}

export function PopoverStack({ children, width = 240 }: { children: ReactNode; width?: number }) {
  return (
    <div className={styles.stack} style={{ width }}>
      {children}
    </div>
  )
}
