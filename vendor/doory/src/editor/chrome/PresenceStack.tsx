import { useMemo, useRef, useState } from 'react'
import { initials, textOn } from '../collab/colors'
import { useCollabSession, useCollabState, usePresenceState } from '../collab/context'
import type { Peer } from '../collab/presence'
import { t } from '../strings'
import { Menu, type MenuItem } from '../ui/Menu'
import { Tooltip } from '../ui/Tooltip'
import styles from './PresenceStack.module.css'

const VISIBLE = 4

/** One entry per person: the connection that was active last speaks for them. */
function people(peers: readonly Peer[], meId: string | undefined): Peer[] {
  const byUser = new Map<string, Peer>()
  for (const peer of peers) {
    if (peer.userId === meId) continue
    const known = byUser.get(peer.userId)
    if (!known || peer.lastActive > known.lastActive) byUser.set(peer.userId, peer)
  }
  return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name) || a.clientId - b.clientId)
}

function roleLabel(peer: Peer): string {
  const r = t.collab.presence
  return peer.role === 'owner' ? r.roleOwner : peer.role === 'edit' ? r.roleEdit : peer.role === 'comment' ? r.roleComment : r.roleView
}

export function Avatar({ peer, size = 28 }: { peer: Pick<Peer, 'name' | 'avatarUrl' | 'color'>; size?: number }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className={styles.avatar} style={{ width: size, height: size, background: peer.color, color: textOn(peer.color), fontSize: Math.round(size * 0.4) }} aria-hidden="true">
      {peer.avatarUrl && !broken ? <img src={peer.avatarUrl} alt="" className={styles.photo} draggable={false} onError={() => setBroken(true)} /> : initials(peer.name)}
    </span>
  )
}

/** The people in this design, as overlapping avatars in the top bar. Clicking one follows their window. */
export function PresenceStack() {
  const session = useCollabSession()
  const peers = usePresenceState((s) => s.peers)
  const following = usePresenceState((s) => s.following)
  const meId = useCollabState((s) => s.me?.id) ?? undefined
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const list = useMemo(() => people(peers ?? [], meId), [peers, meId])
  if (!session || list.length === 0) return null

  const shown = list.slice(0, VISIBLE)
  const rest = list.slice(VISIBLE)
  const toggle = (peer: Peer): void => session.presence.follow(peer.clientId)
  const items: MenuItem[] = rest.map((peer) => ({ id: String(peer.clientId), label: `${peer.name} · ${roleLabel(peer)}`, checked: following === peer.clientId || undefined, onSelect: () => toggle(peer) }))

  return (
    <div className={styles.stack} role="group" aria-label={t.collab.presence.stackLabel(list.map((p) => p.name).join(', '))} data-testid="presence-stack">
      {shown.map((peer) => {
        const on = following === peer.clientId
        const label = `${peer.name} · ${roleLabel(peer)}${peer.idle ? ` · ${t.collab.presence.idle}` : ''}`
        return (
          <Tooltip key={peer.userId} label={label}>
            <button
              type="button"
              className={styles.person}
              data-idle={peer.idle || undefined}
              data-following={on || undefined}
              aria-pressed={on}
              aria-label={on ? t.collab.presence.followStop(peer.name) : t.collab.presence.followStart(peer.name)}
              data-testid="presence-avatar"
              data-user={peer.name}
              onClick={() => toggle(peer)}
            >
              <Avatar peer={peer} />
            </button>
          </Tooltip>
        )
      })}
      {rest.length > 0 ? (
        <>
          <button ref={moreRef} type="button" className={`${styles.person} ${styles.more}`} aria-haspopup="menu" aria-expanded={moreOpen} aria-label={t.collab.presence.morePeople(rest.length)} data-testid="presence-more" onClick={() => setMoreOpen((o) => !o)}>
            +{rest.length}
          </button>
          {moreOpen ? <Menu label={t.collab.presence.stack(list.length)} items={items} anchorRef={moreRef} onClose={() => setMoreOpen(false)} /> : null}
        </>
      ) : null}
    </div>
  )
}
