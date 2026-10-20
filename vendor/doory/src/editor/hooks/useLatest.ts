import { type RefObject, useLayoutEffect, useRef } from 'react'

/** A ref that always holds the latest value, for callbacks that must not change identity. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}
