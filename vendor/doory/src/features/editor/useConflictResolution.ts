import { useCallback, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { designsApi, isApiError } from '@/lib/api'
import { reloadDiscardingChanges } from '@/lib/useUnsavedGuard'
import type { EditorHandle } from '@/types/adapter'
import { useToast } from '@/ui'

/**
 * What the editor's "this design changed somewhere else" banner does: *Reload latest* drops the open changes and loads the
 * server's version; *Keep editing (save as copy)* stores what is on the canvas as a new design of the signed-in user and opens it.
 */
export function useConflictResolution(editorRef: RefObject<EditorHandle | null>, title: string): (choice: 'reload' | 'save-as-copy') => void {
  const navigate = useNavigate()
  const { toast } = useToast()
  return useCallback(
    (choice) => {
      if (choice === 'reload') {
        reloadDiscardingChanges()
        return
      }
      const document = editorRef.current?.getDocument()
      if (!document) return
      designsApi
        .create({ title: `Copy of ${title || 'Untitled design'}`.slice(0, 120), preset: document.meta?.presetId, document })
        .then((copy) => {
          toast({ title: 'Saved as a copy', description: 'Your changes are in a new design.', variant: 'success' })
          navigate(`/design/${copy.id}`)
        })
        .catch((error: unknown) => toast({ title: 'Couldn’t save a copy', description: isApiError(error) ? error.message : 'Please try again.', variant: 'error' }))
    },
    [editorRef, title, navigate, toast],
  )
}
