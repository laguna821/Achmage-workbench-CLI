import { t } from '../../strings'
import { Button } from '../../ui/Button'
import type { ExportFailure } from './exportFailure'
import styles from './print.module.css'
import { useCountdown } from './useCountdown'

interface ExportProblemProps {
  failure: ExportFailure
  /** Runs the same download again. Absent: no retry button (the cause has to change first). */
  onRetry?: () => void
}

/** The message under the options when a download failed: what happened, what to do, and Try again (after the wait the service asked for). */
export function ExportProblem({ failure, onRetry }: ExportProblemProps) {
  const left = useCountdown(failure.retryAfter)
  const waiting = left > 0
  return (
    <div className={styles.problem} role="alert" data-testid="export-problem" data-kind={failure.kind}>
      <p>{failure.message}</p>
      {failure.hint ? <p className={styles.problemHint}>{failure.hint}</p> : null}
      {failure.retryable && onRetry ? (
        <div className={styles.problemActions}>
          <Button size="sm" onClick={onRetry} disabled={waiting}>
            {waiting ? t.print.retryIn(left) : t.print.retry}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
