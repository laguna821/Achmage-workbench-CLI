import type { ReactNode } from 'react'

export const hintId = (id: string) => `${id}-hint`
export const errorId = (id: string) => `${id}-error`

/** Builds the aria-describedby value for a control inside a Field. */
export function describedBy(id: string, hint: ReactNode, error: ReactNode): string | undefined {
  const ids = [error ? errorId(id) : null, hint ? hintId(id) : null].filter(Boolean)
  return ids.length ? ids.join(' ') : undefined
}
