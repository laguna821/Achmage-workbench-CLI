import { ChevronDown } from 'lucide-react'
import { useId, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react'
import { cx } from '@/lib/cx'
import { Field } from './Field'
import { describedBy } from './fieldIds'
import styles from './Select.module.css'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  hideLabel?: boolean
  options: SelectOption[]
  placeholder?: string
  selectSize?: 'sm' | 'md'
  wrapperClassName?: string
  ref?: Ref<HTMLSelectElement>
}

/** Styled native select: free keyboard, typeahead and mobile pickers. */
export function Select({ label, hint, error, hideLabel, options, placeholder, selectSize = 'md', wrapperClassName, className, id, required, ref, ...rest }: SelectProps) {
  const autoId = useId()
  const selectId = id ?? autoId
  return (
    <Field id={selectId} label={label} hint={hint} error={error} hideLabel={hideLabel} required={required} className={wrapperClassName}>
      <div className={styles.wrap} data-size={selectSize}>
        <select
          ref={ref}
          id={selectId}
          className={cx(styles.select, className)}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(selectId, hint, error)}
          {...rest}
        >
          {placeholder ? (
            <option value="" disabled={required}>
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
      </div>
    </Field>
  )
}
