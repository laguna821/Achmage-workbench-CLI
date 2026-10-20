import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react'
import { Tooltip } from './Tooltip'
import styles from './Button.module.css'

type Variant = 'default' | 'primary' | 'ghost' | 'danger' | 'soft'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  /** Toggle state for buttons that stay pressed. */
  pressed?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', pressed, icon, className, children, type = 'button', ...rest },
  ref,
) {
  const cls = [styles.btn, styles[variant], styles[size], pressed ? styles.pressed : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <button ref={ref} type={type} className={cls} aria-pressed={pressed} {...rest}>
      {icon}
      {children}
    </button>
  )
})

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Accessible name — required, since the button shows only an icon. */
  label: string
  shortcut?: string
  pressed?: boolean
  variant?: Variant
  size?: 'sm' | 'md'
  tooltip?: boolean
  tooltipSide?: 'top' | 'bottom' | 'right' | 'left'
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, pressed, variant = 'ghost', size = 'md', tooltip = true, tooltipSide, className, children, type = 'button', disabled, ...rest },
  ref,
) {
  const cls = [styles.btn, styles.icon, styles[variant], styles[size], pressed ? styles.pressed : '', className ?? ''].filter(Boolean).join(' ')
  const button = (
    <button ref={ref} type={type} className={cls} aria-label={label} aria-pressed={pressed} disabled={disabled} {...rest}>
      {children}
    </button>
  )
  if (!tooltip) return button
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide} disabled={disabled}>
      {button}
    </Tooltip>
  )
})
