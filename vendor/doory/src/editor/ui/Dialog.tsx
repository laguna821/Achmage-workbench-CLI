import { type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { usePortalRoot } from '../context'
import { t } from '../strings'
import { IconButton } from './Button'
import styles from './Dialog.module.css'

interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  description?: string
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** Modal dialog with a focus trap, Escape to close and focus restoration. */
export function Dialog({ title, onClose, children, footer, width = 520, description }: DialogProps) {
  const root = usePortalRoot()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const panel = ref.current
    const first = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => previous?.focus?.()
  }, [])

  // The focused control can disappear (a row deleted inside the dialog): Escape must still close it.
  useEffect(() => {
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const panel = ref.current
      if (panel && !panel.contains(document.activeElement)) onClose()
    }
    document.addEventListener('keydown', onDocKey)
    return () => document.removeEventListener('keydown', onDocKey)
  }, [onClose])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((n) => n.offsetParent !== null)
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  if (!root) return null
  return createPortal(
    <div className={styles.overlay} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={styles.dialog}
        style={{ maxWidth: width }}
        onKeyDown={onKeyDown}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <IconButton label={t.dialog.close} onClick={onClose} tooltip={false} size="sm">
            <X size={18} />
          </IconButton>
        </header>
        {description ? (
          <p id={descId} className={styles.desc}>
            {description}
          </p>
        ) : null}
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>,
    root,
  )
}
