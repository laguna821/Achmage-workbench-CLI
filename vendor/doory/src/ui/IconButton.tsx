import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cx } from '@/lib/cx'
import styles from './IconButton.module.css'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** Required: icon-only buttons need an accessible name. */
  label: string
  icon: ReactNode
  size?: 'sm' | 'md' | 'lg'
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger'
  pressed?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({ label, icon, size = 'md', variant = 'ghost', pressed, className, type = 'button', ref, ...rest }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.iconButton, className)}
      data-size={size}
      data-variant={variant}
      aria-label={label}
      aria-pressed={pressed}
      {...rest}
    >
      {icon}
    </button>
  )
}
