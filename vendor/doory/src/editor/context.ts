import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { DoryDocument } from '@/types/document'
import type { EditorEngine } from './engine/editor'
import type { EditorState, SelectionState } from './store/editorStore'

export const EngineContext = createContext<EditorEngine | null>(null)
export const PortalContext = createContext<HTMLElement | null>(null)

/** The editor engine of the nearest `EditorApp`: commands, selection, insert/arrange/style/pages APIs. */
export function useEditor(): EditorEngine {
  const engine = useContext(EngineContext)
  if (!engine) throw new Error('useEditor must be used inside <EditorApp>')
  return engine
}

/** Element popovers, menus and dialogs render into (so editor theme variables apply to them). */
export function usePortalRoot(): HTMLElement | null {
  return useContext(PortalContext)
}

/** Subscribes to a slice of the editor state. Return primitives or stable references from `selector`. */
export function useEditorState<T>(selector: (state: EditorState) => T): T {
  const engine = useEditor()
  return useStore(engine.store, selector)
}

/** Like `useEditorState` for selectors that build arrays/objects (shallow-compared). */
export function useEditorStateShallow<T>(selector: (state: EditorState) => T): T {
  const engine = useEditor()
  return useStore(engine.store, useShallow(selector))
}

export function useSelection(): SelectionState {
  return useEditorState((s) => s.selection)
}

export function useDocument(): DoryDocument {
  return useEditorState((s) => s.doc)
}
