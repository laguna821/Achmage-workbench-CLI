import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref, type RefCallback } from 'react'

/** Controlled/uncontrolled state in one hook. */
export function useControllableState<T>(
  controlled: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T) => void] {
  const [inner, setInner] = useState<T>(defaultValue)
  const isControlled = controlled !== undefined
  const value = isControlled ? controlled : inner
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })
  const set = useCallback(
    (next: T) => {
      if (!isControlled) setInner(next)
      onChangeRef.current?.(next)
    },
    [isControlled],
  )
  return [value, set]
}

function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === 'function') ref(node)
  else if (ref) (ref as { current: T | null }).current = node
}

/** Combines two refs (callback or object) into one callback ref. */
export function useMergedRef<T>(first: Ref<T> | undefined, second: Ref<T> | undefined): RefCallback<T> {
  return useCallback(
    (node: T | null) => {
      assignRef(first, node)
      assignRef(second, node)
    },
    [first, second],
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' && !el.closest('[inert]'),
  )
}

/** Calls `handler` when a pointer goes down outside every given element. */
export function useOutsideClick(
  elements: Array<HTMLElement | null | undefined>,
  handler: (event: PointerEvent) => void,
  active: boolean,
): void {
  const handlerRef = useRef(handler)
  const elementsRef = useRef(elements)
  useEffect(() => {
    handlerRef.current = handler
    elementsRef.current = elements
  })
  useEffect(() => {
    if (!active) return undefined
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (elementsRef.current.some((el) => el?.contains(target))) return
      handlerRef.current(event)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [active])
}

/** useLayoutEffect that is safe during SSR-less tests too. */
export const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function useMediaQuery(query: string): boolean {
  const get = () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}
