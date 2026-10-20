import { UploadError } from '../engine/assets'
import type { EditorEngine } from '../engine/editor'
import { t } from '../strings'

/**
 * Uploads dropped files to the library without placing them on the page (what the picker button does).
 * Mirrors `insert.pickAndUpload`.
 */
export async function uploadToLibrary(editor: EditorEngine, files: readonly File[]): Promise<void> {
  if (editor.readOnly || files.length === 0) return
  const { store } = editor
  store.setState((s) => ({ uploading: s.uploading + files.length }))
  for (const file of files) {
    try {
      const ref = await editor.assets.upload(file, file.name)
      store.setState((s) => ({ uploads: [ref, ...s.uploads.filter((u) => u.id !== ref.id)] }))
    } catch (err) {
      editor.toast(err instanceof UploadError ? err.message : t.errors.upload, 'error')
    } finally {
      store.setState((s) => ({ uploading: Math.max(0, s.uploading - 1) }))
    }
  }
}
