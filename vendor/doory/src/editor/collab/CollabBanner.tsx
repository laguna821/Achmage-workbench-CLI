import { AlertTriangle, X } from 'lucide-react'
import { useState } from 'react'
import { t } from '../strings'
import { Button, IconButton } from '../ui/Button'
import { useCollabSession, useCollabState } from './context'
import styles from './CollabBanner.module.css'

/** What the live connection tells the user when it cannot simply carry on: lost access, a stale session, a design too large to sync. */
export function CollabBanner() {
  const session = useCollabSession()
  const notice = useCollabState((s) => s.notice)
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!session || !notice || dismissed === notice.title) return null
  const dismissible = notice.tone === 'warning'
  return (
    <div role="alert" className={`${styles.banner} ${notice.tone === 'error' ? styles.error : ''}`} data-testid="collab-banner">
      <AlertTriangle size={18} className={styles.icon} aria-hidden="true" />
      <div className={styles.text}>
        <strong>{notice.title}</strong>
        <span>{notice.body}</span>
      </div>
      {notice.action === 'reload' ? (
        <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
          {t.collab.notice.reload}
        </Button>
      ) : null}
      {notice.action === 'sign-in' ? (
        <Button size="sm" variant="primary" onClick={() => session.signIn()}>
          {t.collab.notice.signIn}
        </Button>
      ) : null}
      {dismissible ? (
        <IconButton label={t.collab.notice.dismiss} size="sm" onClick={() => setDismissed(notice.title)}>
          <X size={16} />
        </IconButton>
      ) : null}
    </div>
  )
}
