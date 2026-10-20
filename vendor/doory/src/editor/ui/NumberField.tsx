import { type ReactNode, useId, useRef, useState } from 'react'
import styles from './NumberField.module.css'

interface NumberFieldProps {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Digits kept after the decimal point. */
  decimals?: number
  suffix?: string
  /** What the field accepts (its range, say): the input's tooltip and accessible description. */
  hint?: string
  /** Show the label text (otherwise it is only the accessible name). */
  showLabel?: boolean
  /** Drag the label horizontally to scrub the value. */
  scrub?: boolean
  width?: number
  adornment?: ReactNode
  /** Compact glyph shown instead of the label text (the label stays the accessible name; still scrubbable). */
  glyph?: ReactNode
  disabled?: boolean
  className?: string
}

const clamp = (n: number, min?: number, max?: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
const fmt = (n: number, decimals: number): string => String(Number(n.toFixed(decimals)))

/** Numeric input: type a value, use arrow keys (Shift = ×10), or drag the label to scrub. */
export function NumberField({ label, value, onChange, min, max, step = 1, decimals = 0, suffix, hint, showLabel, scrub = true, width, adornment, glyph, disabled, className }: NumberFieldProps) {
  const id = useId()
  /** What the user is typing; `null` while the field simply mirrors `value`. */
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? fmt(value, decimals)
  const drag = useRef<{ x: number; start: number } | null>(null)

  const commit = (raw: string): void => {
    const n = Number.parseFloat(raw.replace(',', '.'))
    if (Number.isFinite(n)) onChange(clamp(Number(n.toFixed(decimals)), min, max))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
      setDraft(null)
      onChange(clamp(Number((value + delta).toFixed(decimals)), min, max))
    } else if (e.key === 'Escape') {
      setDraft(null)
      e.currentTarget.blur()
    }
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!scrub || disabled) return
    drag.current = { x: e.clientX, start: value }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    onChange(clamp(Number((d.start + (e.clientX - d.x) * step * (e.shiftKey ? 5 : 1)).toFixed(decimals)), min, max))
  }
  const onPointerUp = (): void => {
    drag.current = null
  }

  return (
    <div className={`${styles.field} ${disabled ? styles.disabled : ''} ${className ?? ''}`} style={width ? { width } : undefined}>
      <label
        htmlFor={id}
        className={`${styles.label} ${showLabel === false ? styles.sr : ''} ${scrub && !disabled ? styles.scrub : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title={glyph && scrub ? `${label} (drag to change)` : undefined}
      >
        {glyph ? (
          <>
            <span aria-hidden="true" className={styles.glyph}>
              {glyph}
            </span>
            <span className={styles.sr}>{label}</span>
          </>
        ) : (
          label
        )}
      </label>
      <input
        id={id}
        className={styles.input}
        inputMode="decimal"
        value={text}
        disabled={disabled}
        aria-label={showLabel === false ? label : undefined}
        title={hint}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (draft !== null) commit(draft)
          setDraft(null)
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
      {adornment}
    </div>
  )
}
