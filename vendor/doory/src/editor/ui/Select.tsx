import { ChevronDown } from 'lucide-react'
import type { SelectHTMLAttributes } from 'react'
import styles from './Select.module.css'

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** Accessible name (a visible label next to the control is better; pass it as `aria-label` when there is none). */
  'aria-label': string
}

/** Native select (keyboard, touch and screen-reader behaviour for free) in the editor's pill style. */
export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <span className={`${styles.wrap} ${className ?? ''}`}>
      <select className={styles.select} {...rest}>
        {children}
      </select>
      <ChevronDown className={styles.chevron} size={14} aria-hidden="true" />
    </span>
  )
}
