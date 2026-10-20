import { authApi } from '@/lib/api'
import type { RealtimeConnection } from '@/types/adapter'

/** The `ws://` or `wss://` address of a design's live room on this site. */
export function realtimeAddress(designId: string, where: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${where.protocol === 'https:' ? 'wss:' : 'ws:'}//${where.host}/ws/designs/${encodeURIComponent(designId)}/`
}

export interface RealtimeOptions {
  designId: string
  /** Share-link credentials; omitted for the owner. */
  auth?: { token: string; password?: string }
  /** Renames the design (owner only). */
  setTitle: RealtimeConnection['setTitle']
  /** Opens the shell's sign-in flow; resolves `true` once the user is signed in. */
  requireSignIn(): Promise<boolean>
  onRevision?(revision: number): void
  uploadThumbnail?: RealtimeConnection['uploadThumbnail']
  /** Re-reads the session (the shell updates its own state too); defaults to a plain `GET /auth/me/`. */
  refreshSession?: RealtimeConnection['refreshSession']
}

export function createRealtimeConnection(options: RealtimeOptions): RealtimeConnection {
  let ticket = 0
  const connection: RealtimeConnection = {
    url: realtimeAddress(options.designId),
    auth: options.auth,
    setTitle: options.setTitle,
    requireSignIn: options.requireSignIn,
    refreshSession: options.refreshSession ?? (async () => (await authApi.me()).user !== null),
    onRevision: options.onRevision,
    uploadThumbnail: options.uploadThumbnail,
    flushRef: { current: null },
    early: {
      room: null,
      start() {
        if (connection.early.room) return
        ticket += 1
        const mine = ticket
        // The room code loads on its own, next to the editor's: nothing of it is in the shell's bundle.
        void import('@/editor/collab/room').then(({ openRoom }) => {
          if (mine === ticket && !connection.early.room) connection.early.room = openRoom(connection)
        })
      },
      release() {
        ticket += 1
        connection.early.room?.close()
        connection.early.room = null
      },
    },
  }
  return connection
}

/** Saves what the live room holds, if there is a room; versions snapshot the saved document. */
export function flushLiveRoom(realtime: RealtimeConnection | null | undefined): Promise<void> {
  return realtime?.flushRef.current?.() ?? Promise.resolve()
}
