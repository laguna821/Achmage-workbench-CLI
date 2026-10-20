import { useEffect, useState } from 'react'

/** True while `element` intersects the viewport (used for infinite scroll sentinels). */
export function useInView(element: Element | null, rootMargin = '400px'): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (!element || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver((entries) => setInView(entries.some((entry) => entry.isIntersecting)), { rootMargin })
    observer.observe(element)
    return () => {
      observer.disconnect()
      setInView(false)
    }
  }, [element, rootMargin])
  return inView
}
