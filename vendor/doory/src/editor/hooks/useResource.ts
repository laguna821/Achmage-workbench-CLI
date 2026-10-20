import { useCallback, useEffect, useState } from 'react'

interface ResourceState<T> {
  data: T | null
  failed: boolean
}

/**
 * Loads one value from a service on mount (and again when `load` changes or `reload` is called).
 * `data` is null while loading or after a failure (`failed`); `update` edits the loaded value after a change was
 * saved. Pass a stable `load` (wrap it in `useCallback`); `null` means "nothing to load".
 */
export function useResource<T>(load: (() => Promise<T>) | null): {
  data: T | null
  failed: boolean
  update: (change: (current: T) => T) => void
  reload: () => void
} {
  const [state, setState] = useState<ResourceState<T>>({ data: null, failed: false })
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (!load) return
    let cancelled = false
    load().then(
      (data) => {
        if (!cancelled) setState({ data, failed: false })
      },
      () => {
        if (!cancelled) setState({ data: null, failed: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [load, round])

  const update = useCallback((change: (current: T) => T) => setState((cur) => (cur.data === null ? cur : { data: change(cur.data), failed: false })), [])
  const reload = useCallback(() => {
    setState({ data: null, failed: false })
    setRound((n) => n + 1)
  }, [])
  return { data: state.data, failed: state.failed, update, reload }
}
