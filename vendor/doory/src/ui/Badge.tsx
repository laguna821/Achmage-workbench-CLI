import type { HTMLAttributes } from 'react'
import { cx } from '@/lib/cx'
import styles from './Badge.module.css'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'
}

export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return <span className={cx(styles.badge, className)} data-tone={tone} {...rest} />
}
