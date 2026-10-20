import type { CSSProperties } from 'react'
import bunnyMark from '@/assets/bunny-mark.webp'
import { cx } from '@/lib/cx'
import styles from './Logo.module.css'

export interface LogoProps {
  /** `mark` renders only the icon. */
  variant?: 'full' | 'mark'
  height?: number
  className?: string
  title?: string
}

/** The Doory mark: the bunny sticker, plus the italic wordmark. */
export function Logo({ variant = 'full', height = 28, className, title = 'Doory' }: LogoProps) {
  return (
    <span
      className={cx(styles.logo, className)}
      style={{ '--logo-h': `${height}px` } as CSSProperties}
      role="img"
      aria-label={title}
    >
      <img className={styles.mark} src={bunnyMark} alt="" width={height} height={height} draggable={false} />
      {variant === 'full' ? (
        <span className={styles.word} aria-hidden="true">
          Doory
        </span>
      ) : null}
    </span>
  )
}
