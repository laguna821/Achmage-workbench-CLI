import { useAssetUsage } from '@/lib/api/hooks'
import { formatBytes } from '@/lib/time'
import styles from './UsageMeter.module.css'

/** Storage used by the signed-in user's uploads. Hidden if the server does not report usage. */
export function UsageMeter() {
  const usage = useAssetUsage()
  if (!usage.data) return null
  const { used_bytes: used, quota_bytes: quota } = usage.data
  const percent = quota ? Math.min(100, Math.round((used / quota) * 100)) : null
  return (
    <div className={styles.meter}>
      <p className={styles.label}>
        {quota ? (
          <>
            <strong>{formatBytes(used)}</strong> of {formatBytes(quota)} used
          </>
        ) : (
          <>
            <strong>{formatBytes(used)}</strong> used
          </>
        )}
      </p>
      {percent !== null ? <progress className={styles.bar} max={100} value={percent} data-high={percent >= 90 || undefined} aria-label="Storage used" /> : null}
    </div>
  )
}
