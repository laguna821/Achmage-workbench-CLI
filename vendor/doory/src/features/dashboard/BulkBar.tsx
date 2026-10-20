import { FolderInput, Star, Trash2, X } from 'lucide-react'
import { Button } from '@/ui'
import styles from './BulkBar.module.css'

export interface BulkBarProps {
  count: number
  onStar(): void
  onUnstar(): void
  onMove(): void
  onTrash(): void
  onClear(): void
}

/** Floating action bar shown while designs are selected. */
export function BulkBar({ count, onStar, onUnstar, onMove, onTrash, onClear }: BulkBarProps) {
  if (count === 0) return null
  return (
    <div className={styles.bar} role="region" aria-label="Selected designs">
      <p className={styles.count} role="status">
        {count} selected
      </p>
      <div className={styles.actions}>
        <Button size="sm" variant="ghost" leftIcon={<Star size={16} />} onClick={onStar}>
          Star
        </Button>
        <Button size="sm" variant="ghost" onClick={onUnstar}>
          Unstar
        </Button>
        <Button size="sm" variant="ghost" leftIcon={<FolderInput size={16} />} onClick={onMove}>
          Move
        </Button>
        <Button size="sm" variant="ghost" leftIcon={<Trash2 size={16} />} onClick={onTrash}>
          Trash
        </Button>
      </div>
      <Button size="sm" variant="secondary" leftIcon={<X size={16} />} onClick={onClear}>
        Clear
      </Button>
    </div>
  )
}
