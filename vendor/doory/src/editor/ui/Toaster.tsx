import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { useEditor, useEditorStateShallow } from '../context'
import { t } from '../strings'
import styles from './Toaster.module.css'

/** Non-blocking notifications; errors use role=alert, the rest are polite status messages. */
export function Toaster() {
  const editor = useEditor()
  const toasts = useEditorStateShallow((s) => s.toasts)
  return (
    <div className={styles.stack} aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'} className={`${styles.toast} ${styles[toast.tone]}`}>
          <span className={styles.icon}>{toast.tone === 'error' ? <TriangleAlert size={18} /> : toast.tone === 'success' ? <CheckCircle2 size={18} /> : <Info size={18} />}</span>
          <span className={styles.message}>{toast.message}</span>
          {toast.action ? (
            <button type="button" className={styles.action} onClick={() => { toast.action?.run(); editor.dismissToast(toast.id) }}>
              {toast.action.label}
            </button>
          ) : null}
          <button type="button" className={styles.close} aria-label={t.dialog.close} onClick={() => editor.dismissToast(toast.id)}>
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}
