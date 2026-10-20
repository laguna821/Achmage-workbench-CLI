/**
 * The comment mode of the editor store: whether pins are drawn, whether a click on a page starts a comment. These are plain
 * store actions with no dependency on the comments themselves, so they stay in the first download: the Shift+C command
 * and the pins' loading state use them before the code of the comment sidebar and the pins (`commentsUi.ts` and what
 * hangs on it) has arrived.
 */
import type { EditorEngine } from '../engine/editor'
import type { CommentsUiState } from '../store/editorStore'
import { t } from '../strings'

export function patchComments(editor: EditorEngine, patch: Partial<CommentsUiState>): void {
  editor.store.setState((s) => ({ comments: { ...s.comments, ...patch } }))
}

export function setCommentMode(editor: EditorEngine, on: boolean): void {
  const current = editor.state.comments
  if (current.mode === on) return
  patchComments(editor, on ? { mode: true, pins: true } : { mode: false, draft: null })
  editor.announce(on ? t.comments.announce.modeOn : t.comments.announce.modeOff)
}

/** Shows or hides the pins. Hiding them also ends comment mode and closes what is open, which would be invisible. */
export function setCommentPins(editor: EditorEngine, on: boolean): void {
  if (editor.state.comments.pins === on) return
  patchComments(editor, on ? { pins: true } : { pins: false, mode: false, draft: null, activeThreadId: null })
}
