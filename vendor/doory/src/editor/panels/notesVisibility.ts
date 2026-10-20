/**
 * Whether the Notes bar under the workspace is open. A per-editor flag outside the store (the registry command, the
 * pill button and the bar itself all reach it from different places), remembered for the viewer's next visit like
 * the other view preferences; storage that is missing or refuses to write only means the choice is forgotten.
 */
import { useSyncExternalStore } from 'react'
import { useEditor } from '../context'
import type { EditorEngine } from '../engine/editor'

const KEY = 'doory.editor.notes.v1'

interface Flag {
  open: boolean
  listeners: Set<() => void>
}

const flags = new WeakMap<EditorEngine, Flag>()

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function flagOf(editor: EditorEngine): Flag {
  let flag = flags.get(editor)
  if (!flag) {
    flag = { open: stored(), listeners: new Set() }
    flags.set(editor, flag)
  }
  return flag
}

export function isNotesOpen(editor: EditorEngine): boolean {
  return flagOf(editor).open
}

export function setNotesOpen(editor: EditorEngine, open: boolean): void {
  const flag = flagOf(editor)
  if (flag.open === open) return
  flag.open = open
  try {
    localStorage.setItem(KEY, open ? '1' : '0')
  } catch {
    /* private window or blocked storage: the choice only lasts for this session */
  }
  for (const listener of flag.listeners) listener()
}

export function toggleNotes(editor: EditorEngine): void {
  setNotesOpen(editor, !isNotesOpen(editor))
}

export function useNotesOpen(): boolean {
  const editor = useEditor()
  const flag = flagOf(editor)
  return useSyncExternalStore(
    (listener) => {
      flag.listeners.add(listener)
      return () => flag.listeners.delete(listener)
    },
    () => flag.open,
  )
}
