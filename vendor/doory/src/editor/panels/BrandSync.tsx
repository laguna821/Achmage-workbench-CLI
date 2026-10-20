import { useEffect } from 'react'
import { useEditor, useEditorState } from '../context'
import { pickKit } from './brandOps'
import { setBrandPalette } from './brandPalette'

/**
 * Loads the default brand kit once an account can have one, so its colours show up in every colour picker
 * without the Brand sidebar being open. Renders nothing.
 */
export function BrandSync() {
  const editor = useEditor()
  const mode = useEditorState((s) => s.mode)
  useEffect(() => {
    const brand = editor.adapter.services.brand
    if (!brand || mode === 'guest' || mode === 'shared-view' || mode === 'shared-comment') return
    let cancelled = false
    brand.list().then(
      (kits) => {
        if (!cancelled) setBrandPalette(pickKit(kits))
      },
      () => undefined,
    )
    return () => {
      cancelled = true
      setBrandPalette(null)
    }
  }, [editor, mode])
  return null
}
