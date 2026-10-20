import { useCallback } from 'react'
import { openAccountDialog } from '../chrome/accountGate'
import { useEditor, useEditorState } from '../context'
import { t } from '../strings'
import { useUserFonts } from './userFonts'

export interface FontUploadEntry {
  /** Whether to offer "Upload a font" at all (signed-in users and guests; not visitors of a shared link). */
  available: boolean
  /** Guests are asked to sign up before the dialog opens. */
  gated: boolean
  /** Opens the upload dialog; a guest is first sent through `adapter.requireAccount('brand-kit')`. */
  start(): void
}

export function useFontUploadEntry(): FontUploadEntry {
  const editor = useEditor()
  const mode = useEditorState((s) => s.mode)
  const { canManage } = useUserFonts()
  const gated = !canManage && mode === 'guest'
  const start = useCallback(() => {
    void openAccountDialog(editor, 'brand-kit', 'upload-font', (e) => Boolean(e.adapter.services.fonts.mine), t.userFonts.errors.unavailable)
  }, [editor])
  return { available: canManage || gated, gated, start }
}
