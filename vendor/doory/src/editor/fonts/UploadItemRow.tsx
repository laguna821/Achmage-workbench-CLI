import { AlertCircle, Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { t } from '../strings'
import { formatBytes, variantLabel } from './fontFile'
import type { UploadItem } from './uploadQueue'
import styles from './UploadFontDialog.module.css'

function describeStyle(item: UploadItem): string {
  if (!item.info || item.info.weight === null || item.info.style === null) return t.userFonts.dialog.detectedOnUpload
  return variantLabel(item.info.weight, item.info.style)
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * One file of an upload dialog: a sample drawn in the font itself, what was detected, progress, the result or the
 * reason it was refused. `action` is the dialog's own "remove" button, so the editor's and the dashboard's dialogs
 * share the row and keep their own components.
 */
export function UploadItemRow({ item, action }: { item: UploadItem; action: ReactNode }) {
  const title = item.result?.family ?? item.info?.family ?? baseName(item.file.name)
  const percent = Math.round(item.progress * 100)
  const face = item.previewFamily ? { fontFamily: `"${item.previewFamily}", sans-serif` } : undefined
  return (
    <li className={styles.item} data-status={item.status} data-testid="font-upload-item">
      <span className={styles.sample} style={face} aria-hidden="true">
        {item.status === 'reading' ? <span className={styles.spinner} /> : t.userFonts.dialog.sample}
      </span>
      <div className={styles.itemBody}>
        <div className={styles.itemTitle} style={item.status !== 'error' ? face : undefined}>
          {title}
        </div>
        <div className={styles.itemMeta}>
          {item.file.name} · {formatBytes(item.file.size)}
          {item.status !== 'error' ? ` · ${describeStyle(item)}` : ''}
        </div>
        {item.status === 'uploading' ? (
          <div className={styles.progress} role="progressbar" aria-label={item.file.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div style={{ width: `${percent}%` }} />
          </div>
        ) : null}
        {item.status === 'done' && item.result ? (
          <div className={styles.done} role="status">
            <Check size={14} aria-hidden="true" />
            {t.userFonts.dialog.uploadedAs(item.result.family, t.userFonts.styles(item.result.variants.length))}
          </div>
        ) : null}
        {item.status === 'error' && item.message ? (
          <div className={styles.problem} role="alert" data-kind={item.failure ?? undefined}>
            <AlertCircle size={14} aria-hidden="true" />
            <span>{item.message}</span>
          </div>
        ) : null}
      </div>
      {action}
    </li>
  )
}
