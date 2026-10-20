import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import { cx } from '@/lib/cx'
import styles from './Switch.module.css'

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'role'> {
  label?: ReactNode
  description?: ReactNode
  ref?: Ref<HTMLInputElement>
}

export function Switch({ label, description, className, id, ref, ...rest }: SwitchProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <div className={cx(styles.root, className)}>
      <span className={styles.track}>
        <input ref={ref} id={inputId} type="checkbox" role="switch" className={styles.input} aria-describedby={description ? `${inputId}-desc` : undefined} {...rest} />
        <span className={styles.visual} aria-hidden="true" />
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
