/**
 * Returns `value` only when it is a safe in-app path (blocks open redirects such as `//evil.test` or
 * `https://evil.test`); otherwise `fallback`.
 */
export function safeNextPath(value: string | null | undefined, fallback = '/dashboard'): string {
  if (!value) return fallback
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback
  if (Array.from(value).some((char) => (char.codePointAt(0) ?? 0) < 32)) return fallback
  return value
}

/**
 * Scrolls to the element a URL fragment names (`#faq` -> `<section id="faq">`), the way the browser does for a page load but
 * for in-app navigation, where it never happens. The page may still be loading its code, so it keeps looking until the element
 * appears (or `timeoutMs` has passed). Returns what stops the search. Honours `prefers-reduced-motion` and the element's
 * `scroll-margin-top` (the sticky header).
 */
export function scrollToFragment(hash: string, timeoutMs = 3000): () => void {
  const id = decodeURIComponent(hash.replace(/^#/, ''))
  if (!id) return () => undefined
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const go = (): boolean => {
    const target = document.getElementById(id)
    if (!target) return false
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    return true
  }
  if (go()) return () => undefined
  const observer = new MutationObserver(() => {
    if (go()) stop()
  })
  const timer = window.setTimeout(() => stop(), timeoutMs)
  function stop(): void {
    observer.disconnect()
    window.clearTimeout(timer)
  }
  observer.observe(document.body, { childList: true, subtree: true })
  return stop
}
