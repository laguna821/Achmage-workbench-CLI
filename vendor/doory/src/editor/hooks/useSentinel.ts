import { useCallback, useRef } from 'react'

/**
 * Endless scrolling: returns a ref callback for an element below the list; `loadMore` runs when it comes into view
 * (only while `canLoadMore`).
 */
export function useSentinel(canLoadMore: boolean, loadMore: () => void, margin = 240): (el: HTMLDivElement | null) => void {
  const observer = useRef<IntersectionObserver | null>(null)
  return useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      if (!el || !canLoadMore || typeof IntersectionObserver === 'undefined') return
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMore()
        },
        { rootMargin: `${margin}px` },
      )
      observer.current.observe(el)
    },
    [canLoadMore, loadMore, margin],
  )
}
