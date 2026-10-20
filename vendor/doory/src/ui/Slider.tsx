import { useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { cx } from '@/lib/cx'
import styles from './Slider.module.css'

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'size'> {
  label: ReactNode
  value: number
  onValueChange(value: number): void
  min?: number
  max?: number
  step?: number
  /** Formats the visible value readout and `aria-valuetext`. */
  format?(value: number): string
}

export function Slider({ label, value, onValueChange, min = 0, max = 100, step = 1, format, className, id, ...rest }: SliderProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const text = format ? format(value) : String(value)
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <div className={cx(styles.root, className)}>
      <div className={styles.row}>
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
        <output htmlFor={inputId} className={styles.value}>
          {text}
        </output>
      </div>
      <input
        id={inputId}
        type="range"
        className={styles.input}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={text}
        style={{ ['--fill' as string]: `${percent}%` }}
        onChange={(event) => onValueChange(Number(event.target.value))}
        {...rest}
      />
    </div>
  )
}
