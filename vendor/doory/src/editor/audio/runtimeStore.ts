/**
 * Where the audio runtime of an editor says how to take it down. Kept apart from `runtime.ts` (the player, the previewer
 * and the catalogue) so the editor can release a runtime on teardown without loading any of that code first.
 */
import type { EditorEngine } from '../engine/editor'

const disposers = new WeakMap<EditorEngine, () => void>()

export function onRuntimeDispose(editor: EditorEngine, dispose: () => void): void {
  disposers.set(editor, dispose)
}

/** Stops the sound and releases the audio context of an editor that is going away (nothing to do when audio was never used). */
export function disposeAudioRuntime(editor: EditorEngine): void {
  const dispose = disposers.get(editor)
  if (!dispose) return
  disposers.delete(editor)
  dispose()
}
