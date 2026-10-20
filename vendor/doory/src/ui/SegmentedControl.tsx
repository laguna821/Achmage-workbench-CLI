import { useId, type ReactNode } from 'react'
import { cx } from '@/lib/cx'
import { useControllableState } from './hooks'
import styles from './SegmentedControl.module.css'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** Accessible name when `label` is an icon. */
  ariaLabel?: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  label: string
  options: SegmentedOption<T>[]
  value?: T
  defaultValue?: T
  onChange?: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
}

/** A radio group presented as a pill toggle. Native radios give arrow-key navigation. */
export function SegmentedControl<T extends string>({ label, options, value, defaultValue, onChange, size = 'md', className }: SegmentedControlProps<T>) {
  const name = useId()
  const [current, setCurrent] = useControllableState<T | undefined>(value, defaultValue ?? options[0]?.value, onChange as ((next: T | undefined) => void) | undefined)
  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.root, className)} data-size={size}>
      {options.map((option) => (
        <label key={option.value} className={styles.segment} data-checked={current === option.value || undefined} data-disabled={option.disabled || undefined}>
          <input
            type="radio"
            name={name}
            value={option.value}
            className={styles.input}
            checked={current === option.value}
            disabled={option.disabled}
            aria-label={option.ariaLabel}
            onChange={() => setCurrent(option.value)}
          />
          <span className={styles.text}>{option.label}</span>
        </label>
      ))}
    </div>
  )
}
