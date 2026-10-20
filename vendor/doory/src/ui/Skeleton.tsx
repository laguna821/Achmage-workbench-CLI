import type { CSSProperties, HTMLAttributes } from 'react'
import { cx } from '@/lib/cx'
import styles from './Skeleton.module.css'

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  radius?: CSSProperties['borderRadius']
  circle?: boolean
}

/** Placeholder shimmer. Decorative: hidden from assistive tech (pair with a labelled live region). */
export function Skeleton({ width, height = '1em', radius, circle, className, style, ...rest }: SkeletonProps) {
  return (
    <div
      className={cx(styles.skeleton, className)}
      style={{ width, height, borderRadius: circle ? '50%' : radius, ...style }}
      aria-hidden="true"
      {...rest}
    />
  )
}
