import { cx } from '@/lib/cx'
import styles from './Spinner.module.css'

export interface SpinnerProps {
  size?: number
  /** Accessible label; when omitted the spinner is decorative. */
  label?: string
  className?: string
}

export function Spinner({ size = 18, label, className }: SpinnerProps) {
  return (
    <span
      className={cx(styles.spinner, className)}
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className={styles.track} cx="12" cy="12" r="9" strokeWidth="3" />
        <path className={styles.arc} d="M21 12a9 9 0 0 0-9-9" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  )
}
