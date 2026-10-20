import { MessageSquare } from 'lucide-react'
import { useEffect } from 'react'
import { useCommentsController, useThreads } from './commentsUi'
import styles from './CommentsIcon.module.css'

/** The Comments button's icon with the number of open threads. Loads the comments once, so the number is there before the sidebar is opened. */
export function CommentsIcon() {
  const controller = useCommentsController()
  const { threads } = useThreads(controller)
  useEffect(() => {
    controller.ensureLoaded()
  }, [controller])
  const open = threads.reduce((n, th) => (th.root.resolved ? n : n + 1), 0)
  return (
    <span className={styles.icon}>
      <MessageSquare size={18} aria-hidden="true" />
      {open > 0 ? (
        <span className={styles.badge} data-testid="comments-badge" aria-hidden="true">
          {open > 99 ? '99+' : open}
        </span>
      ) : null}
    </span>
  )
}
