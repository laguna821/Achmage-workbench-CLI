import { useEffect, useState } from 'react'
import { useEditor } from '../context'
import { t } from '../strings'
import { Dialog } from '../ui/Dialog'
import { LoadFailed, LoadingLines } from '../ui/LoadStates'

/** Shown while the code of a lazy dialog downloads: nothing for the first moment (a cached chunk is there before it would be seen), then a dialog with quiet placeholder lines. */
export function DialogLoading({ delayMs = 150 }: { delayMs?: number }) {
  const editor = useEditor()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const id = window.setTimeout(() => setVisible(true), delayMs)
    return () => window.clearTimeout(id)
  }, [delayMs])
  if (!visible) return null
  return (
    <Dialog title={t.lazy.loading} onClose={() => editor.closeDialog()} width={420}>
      <LoadingLines />
    </Dialog>
  )
}

/** A lazy dialog whose code could not be downloaded: the message and a retry, in a dialog of their own. */
export function DialogLoadFailed({ onRetry }: { onRetry(): void }) {
  const editor = useEditor()
  return (
    <Dialog title={t.lazy.failedTitle} onClose={() => editor.closeDialog()} width={420}>
      <LoadFailed onRetry={onRetry} />
    </Dialog>
  )
}
