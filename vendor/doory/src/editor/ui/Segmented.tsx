import { type ReactNode, useId } from 'react'
import styles from './Segmented.module.css'

interface Option<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
  /** Hide the text and show only the icon (the label stays as the accessible name). */
  iconOnly?: boolean
  className?: string
}

export function Segmented<T extends string>({ label, value, options, onChange, iconOnly, className }: SegmentedProps<T>) {
  const name = useId()
  return (
    <div role="radiogroup" aria-label={label} className={`${styles.group} ${className ?? ''}`}>
      {options.map((o) => (
        <label key={o.value} className={`${styles.option} ${o.value === value ? styles.on : ''}`} title={iconOnly ? o.label : undefined}>
          <input type="radio" name={name} className={styles.radio} checked={o.value === value} onChange={() => onChange(o.value)} aria-label={iconOnly ? o.label : undefined} />
          {o.icon}
          {iconOnly ? null : <span>{o.label}</span>}
        </label>
      ))}
    </div>
  )
}
