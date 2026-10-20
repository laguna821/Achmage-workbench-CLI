import type { ReactNode } from 'react'
import { cx } from '@/lib/cx'
import styles from './EmptyState.module.css'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  /** Use a tighter layout inside small panels. */
  compact?: boolean
  className?: string
  role?: 'status' | 'alert'
}

export function EmptyState({ icon, title, description, action, compact, className, role }: EmptyStateProps) {
  return (
    <div className={cx(styles.root, className)} data-compact={compact || undefined} role={role}>
      {icon ? (
        <div className={styles.icon} aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h3 className={styles.title}>{title}</h3>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  )
}
