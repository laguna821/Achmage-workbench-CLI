import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/** True while the system asks for reduced motion (kept current; false where `matchMedia` is missing). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches === true)
  useEffect(() => {
    const query = window.matchMedia?.(QUERY)
    if (!query) return
    const update = (): void => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}
