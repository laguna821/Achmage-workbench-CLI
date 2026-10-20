import { useEffect, useState } from 'react'
import { useEditor } from '../context'

/** Resolves a stored `src` (`idb://…`) to a displayable URL (null until ready or on failure). */
export function useResolvedSrc(src: string | undefined): string | null {
  const editor = useEditor()
  const [state, setState] = useState<{ src: string; url: string } | null>(null)
  useEffect(() => {
    if (!src) return
    let cancelled = false
    editor.assets.resolve(src).then(
      (url) => {
        if (!cancelled) setState({ src, url })
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [editor, src])
  return state && state.src === src ? state.url : null
}
