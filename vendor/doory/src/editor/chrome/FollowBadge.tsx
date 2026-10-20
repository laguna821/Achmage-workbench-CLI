import { X } from 'lucide-react'
import { useCollabSession, usePresenceState } from '../collab/context'
import { t } from '../strings'
import { Avatar } from './PresenceStack'
import styles from './FollowBadge.module.css'

/** Shown over the workspace while this window follows somebody else's. */
export function FollowBadge() {
  const session = useCollabSession()
  const peer = usePresenceState((s) => s.peers.find((p) => p.clientId === s.following) ?? null)
  if (!session || !peer) return null
  return (
    <div className={styles.badge} role="status" data-testid="follow-badge">
      <Avatar peer={peer} size={20} />
      <span className={styles.label}>{t.collab.presence.following(peer.name)}</span>
      <button type="button" className={styles.stop} aria-label={t.collab.presence.stopFollowing} onClick={() => session.presence.follow(null)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
