import { useState } from 'react'
import { cx } from '@/lib/cx'
import { initialsOf } from './initials'
import styles from './Avatar.module.css'

export interface AvatarProps {
  name: string
  src?: string | null
  size?: number
  className?: string
}

export function Avatar({ name, src, size = 36, className }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showImage = Boolean(src) && failedSrc !== src
  return (
    <span className={cx(styles.avatar, className)} style={{ width: size, height: size, fontSize: Math.max(11, size * 0.38) }} role="img" aria-label={name}>
      {showImage ? <img src={src ?? undefined} alt="" className={styles.image} onError={() => setFailedSrc(src ?? null)} /> : <span aria-hidden="true">{initialsOf(name)}</span>}
    </span>
  )
}
