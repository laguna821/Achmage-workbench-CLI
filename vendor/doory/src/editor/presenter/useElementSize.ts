import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { Size } from './fit'

const NO_SIZE: Size = { width: 0, height: 0 }

/** The content size of an element in CSS px, kept current by a ResizeObserver (zero until it is measured). */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, Size] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<Size>(NO_SIZE)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setSize((cur) => (cur.width === el.clientWidth && cur.height === el.clientHeight ? cur : { width: el.clientWidth, height: el.clientHeight }))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, size]
}
