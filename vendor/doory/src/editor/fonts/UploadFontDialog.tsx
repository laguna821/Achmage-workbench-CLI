import { Check, Info, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { FontFamily } from '@/types/api'
import { I } from '../chrome/icons'
import { useEditor, useSelection } from '../context'
import { fontStack } from '../engine/text/fontStack'
import { t } from '../strings'
import { Button, IconButton } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { FONT_EXTENSIONS, MAX_FONT_FILES } from './fontFile'
import { UploadItemRow } from './UploadItemRow'
import { useFontUploads } from './useFontUploads'
import styles from './UploadFontDialog.module.css'

const ACCEPT = `${FONT_EXTENSIONS.map((e) => `.${e}`).join(',')},font/*`

/** Upload fonts: drop or choose up to five files, see what was detected, send them one by one with their own progress and errors. */
export function UploadFontDialog() {
  const editor = useEditor()
  const selection = useSelection()
  const uploads = useFontUploads((data, options) => editor.userFonts.upload(data, options))
  const { items, running, nameTaken } = uploads
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const familyInput = useRef<HTMLInputElement>(null)
  const limitsId = useId()
  const familyId = useId()
  const hintId = useId()

  useEffect(() => {
    if (nameTaken) familyInput.current?.focus()
  }, [nameTaken])

  const close = (): void => {
    uploads.abort()
    editor.closeDialog()
  }

  const single = uploads.results.length > 0 && uploads.results.every((r) => r.id === uploads.results[0].id) ? uploads.results[0] : null
  const textSelected = !editor.readOnly && selection.ids.length > 0 && selection.kinds.every((k) => k === 'text')

  const applyFont = (target: FontFamily): void => {
    editor.style.text({ fontFamily: fontStack(target.family, target.category) }, t.history.changeFont)
    editor.closeDialog()
  }

  const footer = uploads.allDone ? (
    <>
      <Button onClick={close} data-testid="font-upload-close">
        {t.userFonts.dialog.done}
      </Button>
      {single && textSelected ? (
        <Button variant="primary" onClick={() => applyFont(single)} data-testid="font-upload-use">
          {t.userFonts.dialog.useFont(single.family)}
        </Button>
      ) : null}
    </>
  ) : (
    <>
      <Button onClick={close} data-testid="font-upload-cancel">
        {t.userFonts.dialog.cancel}
      </Button>
      <Button variant="primary" disabled={running || uploads.busy || uploads.pending.length === 0} onClick={() => void uploads.send()} data-testid="font-upload-submit">
        {running ? t.userFonts.dialog.uploading : uploads.retrying ? t.userFonts.dialog.retry : t.userFonts.dialog.uploadCount(uploads.pending.length)}
      </Button>
    </>
  )

  return (
    <Dialog title={t.userFonts.dialog.title} description={t.userFonts.dialog.description} onClose={close} width={560} footer={footer}>
      <div className={styles.stack}>
        <button
          type="button"
          className={styles.zone}
          data-over={over || undefined}
          data-testid="font-drop-zone"
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
          {I.upload}
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
          <section aria-label={t.userFonts.dialog.files}>
            <ul className={styles.list}>
              {items.map((item) => (
                <UploadItemRow
                  key={item.id}
                  item={item}
                  action={
                    <IconButton label={t.userFonts.dialog.remove(item.file.name)} size="sm" tooltip={false} disabled={running || item.status === 'uploading'} onClick={() => uploads.remove(item)} data-testid="font-upload-remove">
                      <X size={16} aria-hidden="true" />
                    </IconButton>
                  }
                />
              ))}
            </ul>
          </section>
        ) : null}

        {uploads.allDone ? (
          <p className={styles.success} role="status" data-testid="font-upload-success">
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
          <div className={styles.field}>
            <label htmlFor={familyId} className={styles.label}>
              {t.userFonts.dialog.family} <span>({t.userFonts.dialog.familyOptional})</span>
            </label>
            <input
              ref={familyInput}
              id={familyId}
              className={styles.input}
              value={uploads.family}
              maxLength={100}
              placeholder={uploads.detected}
              disabled={running}
              aria-describedby={hintId}
              aria-invalid={nameTaken || undefined}
              data-testid="font-family-input"
              onChange={(e) => uploads.setFamily(e.target.value)}
            />
            <p id={hintId} className={styles.hint}>
              {uploads.differing.length > 1 && !uploads.family.trim() ? t.userFonts.dialog.differentFamilies(uploads.differing.join(', ')) : t.userFonts.dialog.familyHint}
            </p>
          </div>
        ) : null}

        <p className={styles.licence} data-testid="font-licence">
          <Info size={16} aria-hidden="true" />
          <span>{t.userFonts.dialog.licence}</span>
        </p>
      </div>
    </Dialog>
  )
}
