import { Check, Minus } from 'lucide-react'
import { useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import { cx } from '@/lib/cx'
import { useMergedRef } from './hooks'
import styles from './Checkbox.module.css'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: ReactNode
  description?: ReactNode
  indeterminate?: boolean
  ref?: Ref<HTMLInputElement>
}

export function Checkbox({ label, description, indeterminate = false, className, id, ref, ...rest }: CheckboxProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const inner = useRef<HTMLInputElement>(null)
  const merged = useMergedRef(inner, ref)
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <div className={cx(styles.root, className)}>
      <span className={styles.box}>
        <input ref={merged} id={inputId} type="checkbox" className={styles.input} aria-describedby={description ? `${inputId}-desc` : undefined} {...rest} />
        <span className={styles.visual} aria-hidden="true">
          {indeterminate ? <Minus size={14} strokeWidth={3} /> : <Check size={14} strokeWidth={3} />}
        </span>
      </span>
      {(label || description) && (
        <span className={styles.text}>
          {label ? (
            <label htmlFor={inputId} className={styles.label}>
              {label}
            </label>
          ) : null}
          {description ? (
            <span id={`${inputId}-desc`} className={styles.description}>
              {description}
            </span>
          ) : null}
        </span>
      )}
    </div>
  )
}
