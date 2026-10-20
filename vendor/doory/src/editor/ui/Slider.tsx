import { type CSSProperties, useId } from 'react'
import styles from './Slider.module.css'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** Text shown at the right of the label. */
  display?: string
  className?: string
}

export function Slider({ label, value, min, max, step = 1, onChange, display, className }: SliderProps) {
  const id = useId()
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <div className={`${styles.field} ${className ?? ''}`}>
      <div className={styles.head}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {display !== undefined ? <span className={styles.value}>{display}</span> : null}
      </div>
      <input
        id={id}
        type="range"
        className={styles.range}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}
