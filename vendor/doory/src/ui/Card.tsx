import type { HTMLAttributes, Ref } from 'react'
import { cx } from '@/lib/cx'
import styles from './Card.module.css'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
  padded?: boolean
  ref?: Ref<HTMLDivElement>
}

export function Card({ interactive, padded = true, className, ref, ...rest }: CardProps) {
  return <div ref={ref} className={cx(styles.card, className)} data-interactive={interactive || undefined} data-padded={padded || undefined} {...rest} />
}
