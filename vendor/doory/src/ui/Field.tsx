import type { ReactNode } from 'react'
import { cx } from '@/lib/cx'
import { errorId, hintId } from './fieldIds'
import styles from './Field.module.css'

export interface FieldProps {
  id: string
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  /** Visually hides the label while keeping it for assistive tech. */
  hideLabel?: boolean
  required?: boolean
  className?: string
  children: ReactNode
  /** Extra content on the label row, right aligned (e.g. "Forgot password?"). */
  labelAside?: ReactNode
}

export function Field({ id, label, hint, error, hideLabel, required, className, children, labelAside }: FieldProps) {
  return (
    <div className={cx(styles.field, className)}>
      {label && (
        <div className={cx(styles.labelRow, hideLabel && styles.visuallyHidden)}>
          <label htmlFor={id} className={styles.label}>
            {label}
            {required && (
              <span className={styles.required} aria-hidden="true">
                {' '}
                *
              </span>
            )}
          </label>
          {labelAside}
        </div>
      )}
      {children}
      {error ? (
        <p id={errorId(id)} className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId(id)} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}
