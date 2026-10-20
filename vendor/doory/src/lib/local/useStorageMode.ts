import { useEffect, useState, useSyncExternalStore } from 'react'
import { localRepository } from './repository'
import type { StorageMode } from './types'

/** Live storage mode of the guest repository (`memory` means designs vanish when the tab closes). */
export function useStorageMode(): StorageMode {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    void localRepository.ready().then(() => {
      if (active) setReady(true)
    })
    return () => {
      active = false
    }
  }, [])
  const mode = useSyncExternalStore(
    (listener) => localRepository.subscribe(listener),
    () => localRepository.getStorageMode(),
    () => 'indexeddb' as const,
  )
  return ready ? mode : 'indexeddb'
}
