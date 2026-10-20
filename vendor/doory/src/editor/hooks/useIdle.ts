import { useEffect, useState } from 'react'

/** `true` once the browser has been idle for a moment after the first render, or after `timeoutMs` at the latest. Used to start non-urgent downloads. */
export function useIdle(timeoutMs = 1500): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => setIdle(true), { timeout: timeoutMs })
      return () => window.cancelIdleCallback(id)
    }
    const id = window.setTimeout(() => setIdle(true), Math.min(timeoutMs, 300))
    return () => window.clearTimeout(id)
  }, [timeoutMs])
  return idle
}
