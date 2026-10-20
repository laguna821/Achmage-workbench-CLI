import { useEffect, useState } from 'react'
import type { DocPage } from '@/types/document'
import { useEditor } from '../context'

/** Cached bitmap URL for a page (rendered lazily off the main path); null until ready. */
export function usePageSnapshot(page: DocPage, size: { width: number; height: number }, enabled = true): string | null {
  const editor = useEditor()
  const [url, setUrl] = useState<{ page: DocPage; url: string } | null>(null)
  const { width, height } = size
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const interest = new AbortController()
    editor.snapshots
      .get(page, { width, height }, interest.signal)
      .then((u) => {
        if (!cancelled && u) setUrl({ page, url: u })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      interest.abort()
    }
  }, [editor, page, width, height, enabled])
  // A stale bitmap (older page version) is better than a blank page while the new one renders.
  return url?.url ?? null
}
