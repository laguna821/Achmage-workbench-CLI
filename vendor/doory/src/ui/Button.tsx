import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { cx } from '@/lib/cx'
import styles from './Button.module.css'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface Shared {
  variant?: ButtonVariant
  size?: ButtonSize
  leftIcon?: ReactNode
  rightIcon?: ReactNode
  fullWidth?: boolean
}

export interface ButtonProps extends Shared, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  loading?: boolean
  children?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  leftIcon,
  rightIcon,
  fullWidth,
  disabled,
  className,
  children,
  type = 'button',
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.button, className)}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      data-full={fullWidth || undefined}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (event) => event.preventDefault() : onClick}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} className={styles.spinner} /> : leftIcon}
      {children !== undefined && children !== null && <span className={styles.label}>{children}</span>}
      {!loading && rightIcon}
    </button>
  )
}

export interface LinkButtonProps extends Shared, Omit<LinkProps, 'children'> {
  children?: ReactNode
}

/** A router link that looks like a Button. */
export function LinkButton({ variant = 'primary', size = 'md', leftIcon, rightIcon, fullWidth, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link className={cx(styles.button, className)} data-variant={variant} data-size={size} data-full={fullWidth || undefined} {...rest}>
      {leftIcon}
      {children !== undefined && children !== null && <span className={styles.label}>{children}</span>}
      {rightIcon}
    </Link>
  )
}

export interface AnchorButtonProps extends Shared, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  children?: ReactNode
}

/** A plain anchor (external link) that looks like a Button. */
export function AnchorButton({ variant = 'secondary', size = 'md', leftIcon, rightIcon, fullWidth, className, children, ...rest }: AnchorButtonProps) {
  return (
    <a className={cx(styles.button, className)} data-variant={variant} data-size={size} data-full={fullWidth || undefined} {...rest}>
      {leftIcon}
      {children !== undefined && children !== null && <span className={styles.label}>{children}</span>}
      {rightIcon}
    </a>
  )
}
