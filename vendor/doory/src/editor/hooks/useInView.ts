import { useCallback, useEffect, useState } from 'react'

/**
 * Whether an element is on screen, or within `margin` of it: `[ref, inView]`. Without `IntersectionObserver` (old browsers, jsdom)
 * everything counts as in view. Used to prepare pictures only for the part of a long list that can be seen.
 */
export function useInView<T extends Element>(margin = '240px'): [(el: T | null) => void, boolean] {
  const supported = typeof IntersectionObserver !== 'undefined'
  const [element, setElement] = useState<T | null>(null)
  const [inView, setInView] = useState(!supported)
  const ref = useCallback((el: T | null) => setElement(el), [])
  useEffect(() => {
    if (!supported || !element) return
    const observer = new IntersectionObserver((entries) => setInView(entries[entries.length - 1]?.isIntersecting ?? false), { rootMargin: margin })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, margin, supported])
  return [ref, inView]
}
