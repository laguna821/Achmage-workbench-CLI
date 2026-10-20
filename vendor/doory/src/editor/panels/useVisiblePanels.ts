import { useSyncExternalStore } from 'react'
import { useEditor, useEditorStateShallow } from '../context'
import { panels } from './registry'

/** Panels visible for the current editor state (some need an account service or edit rights). */
export function useVisiblePanels() {
  const editor = useEditor()
  const all = useSyncExternalStore(panels.subscribe, panels.getSnapshot)
  return useEditorStateShallow((state) => all.filter((p) => !p.requires || p.requires({ editor, state })))
}
