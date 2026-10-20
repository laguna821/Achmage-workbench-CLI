import { MessageSquare } from 'lucide-react'
import { useIdle } from '../hooks/useIdle'
import { loadable } from '../ui/loadable'

const glyph = <MessageSquare size={18} aria-hidden="true" />
const WithCount = loadable(() => import('./CommentsIcon').then((m) => m.CommentsIcon), { fallback: glyph, failed: () => glyph })

/**
 * The icon of the Comments button: a plain speech bubble first, the one with the number of open threads once the
 * comments code has arrived. That code (threads, controller) is only fetched when the editor is idle, so it never
 * competes with the first paint; opening the panel earlier fetches it anyway.
 */
export function CommentsButtonIcon() {
  return useIdle() ? <WithCount /> : glyph
}
