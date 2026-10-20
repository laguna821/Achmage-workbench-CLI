import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import { cx } from '@/lib/cx'
import { Field } from './Field'
import { describedBy } from './fieldIds'
import styles from './Input.module.css'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  hideLabel?: boolean
  labelAside?: ReactNode
  leftIcon?: ReactNode
  /** Trailing element inside the field (e.g. a show/hide toggle). */
  rightSlot?: ReactNode
  inputSize?: 'sm' | 'md' | 'lg'
  wrapperClassName?: string
  ref?: Ref<HTMLInputElement>
}

export function Input({
  label,
  hint,
  error,
  hideLabel,
  labelAside,
  leftIcon,
  rightSlot,
  inputSize = 'md',
  wrapperClassName,
  className,
  id,
  required,
  ref,
  ...rest
}: InputProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <Field id={inputId} label={label} hint={hint} error={error} hideLabel={hideLabel} required={required} className={wrapperClassName} labelAside={labelAside}>
      <div className={styles.control} data-size={inputSize} data-invalid={error ? true : undefined} data-disabled={rest.disabled || undefined}>
        {leftIcon ? <span className={styles.icon}>{leftIcon}</span> : null}
        <input
          ref={ref}
          id={inputId}
          className={cx(styles.input, className)}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(inputId, hint, error)}
          {...rest}
        />
        {rightSlot ? <span className={styles.slot}>{rightSlot}</span> : null}
      </div>
    </Field>
  )
}
