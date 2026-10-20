import { useId, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react'
import { cx } from '@/lib/cx'
import { Field } from './Field'
import { describedBy } from './fieldIds'
import styles from './Textarea.module.css'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  hideLabel?: boolean
  wrapperClassName?: string
  ref?: Ref<HTMLTextAreaElement>
}

export function Textarea({ label, hint, error, hideLabel, wrapperClassName, className, id, required, rows = 4, ref, ...rest }: TextareaProps) {
  const autoId = useId()
  const textareaId = id ?? autoId
  return (
    <Field id={textareaId} label={label} hint={hint} error={error} hideLabel={hideLabel} required={required} className={wrapperClassName}>
      <textarea
        ref={ref}
        id={textareaId}
        rows={rows}
        className={cx(styles.textarea, className)}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(textareaId, hint, error)}
        {...rest}
      />
    </Field>
  )
}
