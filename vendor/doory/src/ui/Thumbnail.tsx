import { ImageIcon } from 'lucide-react'
import { useState } from 'react'
import { cx } from '@/lib/cx'
import styles from './Thumbnail.module.css'

export interface ThumbnailProps {
  src: string | null | undefined
  alt: string
  /** width / height, used to reserve space so the grid does not jump while images load. */
  aspect?: number
  className?: string
  fit?: 'cover' | 'contain'
  /** Size of the design: without a picture, a blank page of these proportions stands in for it (a new, untouched design). */
  page?: { width: number; height: number }
}

/** Image with a quiet fallback for missing or failed thumbnails: a blank page when the design's size is known. */
export function Thumbnail({ src, alt, aspect = 1, className, fit = 'cover', page }: ThumbnailProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const usable = Boolean(src) && failedSrc !== src
  return (
    <div className={cx(styles.frame, className)} style={{ aspectRatio: String(aspect) }} data-loaded={(usable && loaded === src) || undefined}>
      {usable ? (
        <img src={src ?? undefined} alt={alt} loading="lazy" decoding="async" className={styles.image} data-fit={fit} onLoad={() => setLoaded(src ?? null)} onError={() => setFailedSrc(src ?? null)} />
      ) : (
        <div className={styles.fallback} role="img" aria-label={alt}>
          {page && page.width > 0 && page.height > 0 ? (
            <span className={styles.page} style={{ aspectRatio: `${page.width} / ${page.height}`, ...(page.width / page.height >= aspect ? { width: '72%' } : { height: '72%' }) }} />
          ) : (
            <ImageIcon size={24} aria-hidden="true" />
          )}
        </div>
      )}
    </div>
  )
}
