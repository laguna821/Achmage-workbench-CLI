import { Spinner, VisuallyHidden } from '@/ui'
import styles from './PageLoader.module.css'

/** Centered loading state for route transitions and session checks. */
export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className={styles.root} role="status">
      <Spinner size={28} />
      <VisuallyHidden>{label}</VisuallyHidden>
    </div>
  )
}
