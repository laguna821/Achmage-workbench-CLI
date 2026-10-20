import { t } from '../strings'
import { Button } from './Button'
import { Skeleton } from './Skeleton'
import styles from './loadable.module.css'

/** Placeholder of a part that is on its way: a few quiet lines, announced as busy to assistive technology. */
export function LoadingLines() {
  return (
    <div className={styles.skeleton} role="status" aria-busy="true" aria-label={t.lazy.loading}>
      <Skeleton height={18} width="60%" />
      <Skeleton height={64} />
      <Skeleton height={64} />
      <Skeleton height={18} width="40%" />
    </div>
  )
}

/** The code of a part could not be downloaded (offline, or a new release replaced the files): says so and offers to try again. */
export function LoadFailed({ onRetry }: { onRetry(): void }) {
  return (
    <div className={styles.failed} role="alert">
      <p>{t.lazy.failed}</p>
      <p className={styles.hint}>{t.lazy.failedHint}</p>
      <Button variant="soft" onClick={onRetry}>
        {t.lazy.retry}
      </Button>
    </div>
  )
}
