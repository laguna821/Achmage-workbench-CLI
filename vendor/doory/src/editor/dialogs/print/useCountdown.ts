import { useEffect, useState } from 'react'

/** Whole seconds left until `seconds` have passed since the first render, counting down once a second. */
export function useCountdown(seconds: number | null): number {
  const [left, setLeft] = useState(seconds ?? 0)
  useEffect(() => {
    if (!seconds) return
    const end = Date.now() + seconds * 1000
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((end - Date.now()) / 1000))
      setLeft(remaining)
      if (remaining === 0) window.clearInterval(timer)
    }, 250)
    return () => window.clearInterval(timer)
  }, [seconds])
  return seconds ? left : 0
}
