import { useSyncExternalStore } from 'react'

/**
 * The browser tells when the device pixel ratio changes (browser zoom, a window dragged to another screen) through a
 * media query on the current ratio, which stops matching; so the query is made again for the new ratio every time.
 */
function subscribe(notify: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  let query: MediaQueryList | null = null
  const onChange = (): void => {
    notify()
    arm()
  }
  const arm = (): void => {
    query?.removeEventListener('change', onChange)
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    query.addEventListener('change', onChange)
  }
  arm()
  return () => query?.removeEventListener('change', onChange)
}

const read = (): number => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)

/** Device pixels per CSS pixel, kept up to date. */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribe, read, () => 1)
}
