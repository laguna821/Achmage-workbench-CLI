import { useEffect } from 'react'
import type { SaveState } from '@/types/adapter'

/** True while the editor holds a change that is not stored yet, or could not be stored. */
export function hasUnsavedChanges(state: SaveState | null): boolean {
  return state !== null && (state.status === 'dirty' || state.status === 'saving' || state.status === 'error' || state.status === 'conflict')
}

let bypass = false

/** Reloads the page without the "leave site?" question: for the user's own choice to throw the open changes away. */
export function reloadDiscardingChanges(): void {
  bypass = true
  window.location.reload()
}

/** While `active`, the browser asks for confirmation before the tab is closed or the page reloaded. */
export function useUnsavedGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined
    const warn = (event: BeforeUnloadEvent) => {
      if (bypass) return
      event.preventDefault()
      // Older browsers only ask when a return value is set.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active])
}
