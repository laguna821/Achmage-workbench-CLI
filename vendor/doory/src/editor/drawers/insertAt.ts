import type { EditorEngine } from '../engine/editor'

/** Where the next insert goes on the active page: its centre, stepped aside from what is already there (`editor.insert.center`). */
export function pageCentre(editor: EditorEngine): { x: number; y: number } {
  return editor.insert.center()
}
