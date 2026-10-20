import type { CSSProperties } from 'react'
import styles from './Skeleton.module.css'

export function Skeleton({ width, height = 14, radius = 6, className, style }: { width?: number | string; height?: number | string; radius?: number; className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`${styles.skeleton} ${className ?? ''}`} style={{ width, height, borderRadius: radius, ...style }} />
}
