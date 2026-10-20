import { AlertTriangle, X } from 'lucide-react'
import { useState } from 'react'
import { useEditorState } from './context'
import { t } from './strings'
import { Button, IconButton } from './ui/Button'
import styles from './ConflictBanner.module.css'

interface ConflictBannerProps {
  onResolve?: (choice: 'reload' | 'save-as-copy') => void
}

/** Non-blocking banner shown after a save was rejected because the design changed elsewhere. */
export function ConflictBanner({ onResolve }: ConflictBannerProps) {
  const conflict = useEditorState((s) => s.conflict)
  const [dismissed, setDismissed] = useState(false)
  const [lastSeen, setLastSeen] = useState(false)
  if (conflict !== lastSeen) {
    setLastSeen(conflict)
    if (conflict) setDismissed(false)
  }
  if (!conflict || dismissed) return null
  return (
    <div role="alert" className={styles.banner}>
      <AlertTriangle size={18} className={styles.icon} />
      <div className={styles.text}>
        <strong>{t.save.conflictTitle}</strong>
        <span>{t.save.conflictBody}</span>
      </div>
      {onResolve ? (
        <div className={styles.actions}>
          <Button size="sm" onClick={() => onResolve('reload')}>
            {t.save.reload}
          </Button>
          <Button size="sm" variant="primary" onClick={() => onResolve('save-as-copy')}>
            {t.save.keepEditing}
          </Button>
        </div>
      ) : null}
      <IconButton label={t.save.dismiss} size="sm" onClick={() => setDismissed(true)}>
        <X size={16} />
      </IconButton>
    </div>
  )
}
