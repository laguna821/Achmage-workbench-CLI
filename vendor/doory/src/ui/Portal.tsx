import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Renders children into document.body (the app is client-rendered only). */
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}
