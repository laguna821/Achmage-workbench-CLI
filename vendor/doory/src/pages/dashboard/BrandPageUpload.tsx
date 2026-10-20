import { Check, Info, Upload, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { t } from '@/editor/strings'
import { FONT_EXTENSIONS, MAX_FONT_FILES } from '@/editor/fonts/fontFile'
import { UploadItemRow } from '@/editor/fonts/UploadItemRow'
import { useFontUploads } from '@/editor/fonts/useFontUploads'
import { fontsApi } from '@/lib/api'
import { useRememberFont } from '@/lib/api/hooks'
import { Button, Dialog, IconButton, Input } from '@/ui'
import styles from '@/editor/fonts/UploadFontDialog.module.css'

const ACCEPT = `${FONT_EXTENSIONS.map((e) => `.${e}`).join(',')},font/*`

function Content({ onClose }: { onClose(): void }) {
  const remember = useRememberFont()
  const uploads = useFontUploads(async (data, options) => {
    const family = await fontsApi.upload(data, options)
    remember(family)
    return family
  })
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const familyInput = useRef<HTMLInputElement>(null)
  const limitsId = useId()
  const { items, running, nameTaken } = uploads

  useEffect(() => {
    if (nameTaken) familyInput.current?.focus()
  }, [nameTaken])

  const close = (): void => {
    uploads.abort()
    onClose()
  }

  return (
    <Dialog
      open
      onClose={close}
      title={t.userFonts.dialog.title}
      description={t.userFonts.dialog.description}
      size="lg"
      footer={
        uploads.allDone ? (
          <Button onClick={close}>{t.userFonts.dialog.done}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              {t.userFonts.dialog.cancel}
            </Button>
            <Button loading={running} disabled={uploads.busy || uploads.pending.length === 0} onClick={() => void uploads.send()}>
              {uploads.retrying ? t.userFonts.dialog.retry : t.userFonts.dialog.uploadCount(uploads.pending.length)}
            </Button>
          </>
        )
      }
    >
      <div className={styles.stack}>
        <button
          type="button"
          className={styles.zone}
          data-over={over || undefined}
          aria-describedby={limitsId}
          disabled={running || items.length >= MAX_FONT_FILES}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            if (!running) uploads.addFiles([...e.dataTransfer.files])
          }}
        >
          <Upload size={24} aria-hidden="true" />
          <strong>{over ? t.userFonts.dialog.dropActive : t.userFonts.dialog.drop}</strong>
          <span>
            {t.userFonts.dialog.or} <u>{t.userFonts.dialog.choose}</u>
          </span>
        </button>
        <p id={limitsId} className={styles.limits}>
          {t.userFonts.dialog.limits}
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className={styles.fileInput}
          tabIndex={-1}
          aria-hidden="true"
          data-testid="font-file-input"
          onChange={(e) => {
            uploads.addFiles([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        {uploads.notice ? (
          <p className={styles.notice} role="status">
            {uploads.notice}
          </p>
        ) : null}
        {items.length > 0 ? (
          <ul className={styles.list} aria-label={t.userFonts.dialog.files}>
            {items.map((item) => (
              <UploadItemRow
                key={item.id}
                item={item}
                action={<IconButton label={t.userFonts.dialog.remove(item.file.name)} size="sm" variant="ghost" disabled={running || item.status === 'uploading'} icon={<X size={16} />} onClick={() => uploads.remove(item)} />}
              />
            ))}
          </ul>
        ) : null}
        {uploads.allDone ? (
          <p className={styles.success} role="status">
            <Check size={16} aria-hidden="true" />
            {t.userFonts.dialog.allDone(uploads.uploaded.length)}
          </p>
        ) : null}
        {!uploads.allDone && !running && uploads.failed.some((i) => i.failure !== 'file') ? (
          <p className={styles.notice} role="status">
            {uploads.stopped ? t.userFonts.dialog.stopped : t.userFonts.dialog.someFailed}
          </p>
        ) : null}
        {items.length > 0 && !uploads.allDone ? (
          <Input
            ref={familyInput}
            label={`${t.userFonts.dialog.family} (${t.userFonts.dialog.familyOptional})`}
            value={uploads.family}
            maxLength={100}
            placeholder={uploads.detected}
            disabled={running}
            error={nameTaken ? t.userFonts.errors.nameTaken : undefined}
            hint={uploads.differing.length > 1 && !uploads.family.trim() ? t.userFonts.dialog.differentFamilies(uploads.differing.join(', ')) : t.userFonts.dialog.familyHint}
            onChange={(e) => uploads.setFamily(e.target.value)}
          />
        ) : null}
        <p className={styles.licence}>
          <Info size={16} aria-hidden="true" />
          <span>{t.userFonts.dialog.licence}</span>
        </p>
      </div>
    </Dialog>
  )
}

/** Upload fonts from the dashboard: the same dialog flow as in the editor, in the dashboard's components. */
export function UploadFontsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return open ? <Content onClose={onClose} /> : null
}
