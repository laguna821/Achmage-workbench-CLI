/**
 * The connection to a design's room: the shared document, the awareness table and the provider that keeps both in
 * step with the server. It does not need the editor, so the shell can open it while the design and the editor are
 * still loading (`RealtimeConnection.early`); the editor's `CollabSession` takes it over when it is there.
 */
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { RealtimeConnection } from '@/types/adapter'
import { CollabProvider, type ProviderOptions } from './provider'

export interface RoomOptions {
  createSocket?: ProviderOptions['createSocket']
  random?: ProviderOptions['random']
}

/**
 * The shared document of an editor. It keeps the content of what was deleted during the session (`gc: false`): Yjs'
 * undo manager follows chains of restored items, and when a link of such a chain has been collected (somebody deleted a
 * page or shape that an undo had brought back) it throws in the middle of an undo and leaves half of it done. The cost
 * is the old values of the properties changed in one session, a few hundred kB after a long one.
 */
export function newSharedDoc(): Y.Doc {
  return new Y.Doc({ gc: false })
}

export class Room {
  readonly ydoc = newSharedDoc()
  readonly awareness = new Awareness(this.ydoc)
  readonly provider: CollabProvider

  constructor(realtime: RealtimeConnection, options: RoomOptions = {}) {
    this.provider = new CollabProvider({
      url: realtime.url,
      doc: this.ydoc,
      awareness: this.awareness,
      auth: realtime.auth,
      createSocket: options.createSocket,
      random: options.random,
      onSaved: (revision) => realtime.onRevision?.(revision),
      onSignInRequired: () => realtime.requireSignIn(),
      refreshSession: realtime.refreshSession,
    })
    this.provider.connect()
  }

  /** Closes the connection and releases everything the room holds. */
  close(): void {
    this.provider.destroy()
    this.awareness.destroy()
    this.ydoc.destroy()
  }
}

/** Opens the connection right away. */
export function openRoom(realtime: RealtimeConnection, options?: RoomOptions): Room {
  return new Room(realtime, options)
}

/** The room the shell opened ahead of the editor, if there is one; the caller owns it from now on. */
export function takeEarlyRoom(realtime: RealtimeConnection): Room | null {
  const room = realtime.early.room
  realtime.early.room = null
  return room instanceof Room ? room : null
}
