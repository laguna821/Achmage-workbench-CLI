import type { HTMLAttributes } from 'react'
import styles from './VisuallyHidden.module.css'

/** Content available to assistive tech only. */
export function VisuallyHidden({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={[styles.hidden, className].filter(Boolean).join(' ')} {...rest} />
}
