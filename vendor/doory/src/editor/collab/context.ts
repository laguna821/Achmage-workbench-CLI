import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { PresenceState } from './presence'
import type { CollabSession, CollabState } from './session'

/** The live-editing session of the nearest editor, or `null` while the design is edited alone. */
export const CollabContext = createContext<CollabSession | null>(null)

export function useCollabSession(): CollabSession | null {
  return useContext(CollabContext)
}

const IDLE = createStore<CollabState | null>(() => null)

/** Reads a slice of the session's state; `null` when there is no session. */
export function useCollabState<T>(selector: (state: CollabState) => T): T | null {
  const session = useContext(CollabContext)
  const store = (session?.store ?? IDLE) as typeof IDLE
  return useStore(store, (state) => (state ? selector(state) : null))
}

const NO_PRESENCE = createStore<PresenceState | null>(() => null)

/** Reads a slice of who else is here; `null` when there is no session. */
export function usePresenceState<T>(selector: (state: PresenceState) => T): T | null {
  const session = useContext(CollabContext)
  const store = (session?.presence.store ?? NO_PRESENCE) as typeof NO_PRESENCE
  return useStore(store, (state) => (state ? selector(state) : null))
}
