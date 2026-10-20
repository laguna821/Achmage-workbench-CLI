import { useCallback, useState } from 'react'
import { safeGetItem, safeSetItem } from './storage'

/** useState backed by localStorage for per-viewer conveniences (layout, sort…). Never throws. */
export function usePersistedState<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = safeGetItem(key)
    return allowed.find((candidate) => candidate === stored) ?? initial
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      safeSetItem(key, next)
    },
    [key],
  )
  return [value, set]
}
