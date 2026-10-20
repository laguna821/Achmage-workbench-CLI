import { useState } from 'react'
import { useEditor, useEditorState } from '../context'
import { t } from '../strings'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import styles from './dialogs.module.css'

export function RenameDialog({ onTitle }: { onTitle: (title: string) => void }) {
  const editor = useEditor()
  const title = useEditorState((s) => s.title)
  const [value, setValue] = useState(title)
  const submit = (): void => {
    editor.setTitle(value)
    onTitle(editor.state.title)
    editor.closeDialog()
  }
  return (
    <Dialog
      title={t.dialog.renameTitle}
      onClose={() => editor.closeDialog()}
      width={440}
      footer={
        <>
          <Button onClick={() => editor.closeDialog()}>{t.dialog.cancel}</Button>
          <Button variant="primary" onClick={submit}>
            {t.dialog.apply}
          </Button>
        </>
      }
    >
      <label className={styles.field}>
        <span>{t.dialog.renameField}</span>
        <input className={styles.input} value={value} maxLength={120} data-autofocus onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
    </Dialog>
  )
}
