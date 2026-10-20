import { Copy, Download } from 'lucide-react'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useEditor, useEditorState } from '../context'
import { safeMultiplier } from '../engine/render'
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions, type ExportStage, exportFilename, exportFormats, pageFilename, parsePageRange, sanitizeFilename } from '../engine/export/registry'
import { type PageSelection, copyPageAsPng, downloadFiles, pickPages, runExport } from '../engine/export/exporter'
import { FILENAME_STYLES, type FilenameStyle, unixNow } from '../engine/export/filenames'
import { zipFilename } from '../engine/export/zip'
import { getPageSize, sameSize } from '../engine/pageSizes'
import { usePersistedState } from '@/lib/usePersistedState'
import { t } from '../strings'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Segmented } from '../ui/Segmented'
import { Slider } from '../ui/Slider'
import { Switch } from '../ui/Switch'
import { ExportProblem } from './print/ExportProblem'
import { PrintSection } from './print/PrintSection'
import type { VideoFormat } from '../engine/export/video/options'
import { LazyVideoSection } from './VideoSectionLoader'
import { AudioCredits } from '../panels/AudioCredits'
import { type ExportFailure, describeExportFailure, isCancellation } from './print/exportFailure'
import { type PrintSettings, describeSizes, loadPrintSettings, savePrintSettings } from './print/printOptions'
import printStyles from './print/print.module.css'
import styles from './dialogs.module.css'

type Scope = 'all' | 'current' | 'range'
const TIMESTAMP = ['off', 'on'] as const

export function DownloadDialog({ props }: { props?: Record<string, unknown> } = {}) {
  const editor = useEditor()
  const allFormats = useSyncExternalStore(exportFormats.subscribe, exportFormats.getSnapshot)
  const formats = allFormats.filter((f) => !f.available || f.available(editor))
  const doc = useEditorState((s) => s.doc)
  // `openDialog('download', { format: 'mp4' })` starts on that format (the Download menu's "Video or GIF…").
  const [formatId, setFormatId] = useState(() => formats.find((f) => f.id === props?.format)?.id ?? formats[0]?.id ?? 'png')
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [print, setPrint] = useState<PrintSettings>(() => loadPrintSettings(editor.designId))
  const [scope, setScope] = useState<Scope>('all')
  const [range, setRange] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [stage, setStage] = useState<ExportStage | undefined>()
  const [failure, setFailure] = useState<{ id: number; value: ExportFailure } | null>(null)
  // File names are a choice per browser; the instance's default holds until one is made.
  const namingDefault = editor.adapter.exportFilenames
  const [nameStyle, setNameStyle] = usePersistedState<FilenameStyle>('doory-export-filenames', namingDefault?.style ?? 'simple', FILENAME_STYLES)
  const [stamp, setStamp] = usePersistedState<(typeof TIMESTAMP)[number]>('doory-export-filename-timestamp', namingDefault?.timestamp ? 'on' : 'off', TIMESTAMP)
  const [exampleUnix] = useState(unixNow)
  const abort = useRef<AbortController | null>(null)
  const failures = useRef(0)
  /** Video formats: where the section draws its buttons, and whether a video is being made or shown (the choices above are held still). */
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null)
  const [videoLocked, setVideoLocked] = useState(false)
  const format = formats.find((f) => f.id === formatId) ?? formats[0]
  const total = doc.pages.length
  const pageRange = useMemo(() => (scope === 'range' ? parsePageRange(range, total) : null), [scope, range, total])
  const rangeInvalid = scope === 'range' && pageRange === null
  const busy = progress !== null

  /** A change of the print options: kept for the next visit to this design. */
  const changePrint = (next: PrintSettings): void => {
    setPrint(next)
    savePrintSettings(editor.designId, next)
  }

  const selected = useMemo<PageSelection>(() => (scope === 'all' ? { kind: 'all' } : scope === 'current' ? { kind: 'current' } : { kind: 'pages', pages: pageRange ?? [] }), [scope, pageRange])
  const selection = (): PageSelection => selected
  const activePageId = useEditorState((s) => s.activePageId)
  // The pages that will be exported, in document order.
  const chosenPages = useMemo(() => (rangeInvalid ? [] : pickPages(doc, activePageId, selected)), [doc, activePageId, selected, rangeInvalid])
  const chosen = chosenPages.map(({ page }) => getPageSize(doc, page.id))
  const size = chosen[0] ?? editor.pageSizeOf(editor.state.activePageId)
  const mixed = chosen.some((s) => !sameSize(s, size))
  const clamped = format?.controls.scale && chosen.some((s) => safeMultiplier(s.width, s.height, options.scale) < options.scale - 1e-6)
  const video = format?.controls.video === true
  const videoFormats = formats.filter((f) => f.controls.video)
  const zipped = chosen.length > 1 && format?.mime !== 'application/pdf' && !video
  const printing = format?.controls.print === true
  const exampleName = (): string => {
    if (!format) return ''
    const naming = { style: nameStyle, unix: stamp === 'on' ? exampleUnix : null }
    const title = editor.state.title
    if (zipped) return zipFilename(title, naming)
    const first = chosenPages[0]
    const ctx = { document: doc, title, naming }
    const suffix = format.server && printing ? 'print' : undefined
    const simple = format.mime === 'application/pdf' || video ? `${sanitizeFilename(title) || 'design'}${suffix ? '-print' : ''}.${format.extension}` : pageFilename(title, format.extension, (first?.index ?? 0) + 1, chosenPages.length, total)
    const perPage = format.mime !== 'application/pdf' && !video
    return exportFilename(ctx, simple, format.extension, size, perPage ? (first?.index ?? 0) : null, suffix)
  }

  const formatCard = (f: (typeof formats)[number]) => (
    <label key={f.id} className={`${styles.formatCard} ${f.id === format?.id ? styles.formatOn : ''}`}>
      <input type="radio" name="export-format" checked={f.id === format?.id} onChange={() => setFormatId(f.id)} />
      <strong>{f.label}</strong>
    </label>
  )

  const fail = (error: unknown): void => {
    failures.current += 1
    setFailure({ id: failures.current, value: describeExportFailure(error) })
  }

  const download = async (): Promise<void> => {
    if (!format || rangeInvalid) return
    setFailure(null)
    setProgress(0)
    setStage(undefined)
    const controller = new AbortController()
    abort.current = controller
    const effective: ExportOptions = printing ? { ...options, bleedMm: print.bleedMm, cropMarks: print.cropMarks } : options
    try {
      const files = await runExport(editor, {
        formatId: format.id,
        pages: selection(),
        options: effective,
        onProgress: (fraction, next) => {
          setProgress(fraction)
          setStage(next)
        },
        signal: controller.signal,
        filenames: { style: nameStyle, timestamp: stamp === 'on' },
      })
      downloadFiles(files)
      editor.toast(t.dialog.downloadDone, 'success')
      editor.closeDialog()
    } catch (err) {
      if (isCancellation(err)) editor.toast(t.print.cancelled)
      else fail(err)
      setProgress(null)
    }
  }

  const copy = async (): Promise<void> => {
    setFailure(null)
    try {
      await copyPageAsPng(editor)
      editor.toast(t.dialog.downloadCopied, 'success')
    } catch (err) {
      fail(err)
    }
  }

  const close = (): void => {
    abort.current?.abort()
    editor.closeDialog()
  }

  return (
    <Dialog
      title={t.dialog.downloadTitle}
      onClose={close}
      width={560}
      footer={
        video ? (
          <div ref={setFooterSlot} style={{ display: 'flex', flex: 1, alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }} />
        ) : (
        <>
          {busy ? (
            <Button onClick={() => abort.current?.abort()}>{t.print.cancel}</Button>
          ) : (
            <Button icon={<Copy size={16} />} onClick={() => void copy()}>
              {t.dialog.downloadCopy}
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <Button variant="primary" icon={<Download size={16} />} onClick={() => void download()} disabled={busy || rangeInvalid || !format}>
            {busy ? t.dialog.downloadWorking : t.dialog.downloadButton}
          </Button>
        </>
        )
      }
    >
      <div className={styles.stack}>
        <fieldset className={styles.fieldset} disabled={videoLocked} style={videoLocked ? { opacity: 0.6 } : undefined}>
          <legend>{t.dialog.downloadFormat}</legend>
          <div className={styles.formats} role="radiogroup" aria-label={t.dialog.downloadFormat}>
            {formats.filter((f) => !f.controls.video).map(formatCard)}
          </div>
          {videoFormats.length > 0 ? (
            <>
              <span className={styles.groupTitle}>{t.video.group}</span>
              <div className={styles.formats} role="radiogroup" aria-label={t.video.group}>
                {videoFormats.map(formatCard)}
              </div>
            </>
          ) : null}
          {format?.description ? (
            <small className={styles.formatNote} data-testid="download-format-note">
              {format.description}
            </small>
          ) : null}
        </fieldset>

        {format?.controls.scale ? (
          <div className={styles.field}>
            <span>{t.dialog.downloadScale}</span>
            <Segmented
              label={t.dialog.downloadScale}
              value={String(options.scale)}
              onChange={(v) => setOptions((o) => ({ ...o, scale: Number(v) }))}
              options={['1', '2', '3', '4'].map((v) => ({ value: v, label: `${v}×` }))}
            />
            <small className={styles.muted} data-testid="download-size">
              {mixed ? t.dialog.downloadEachSize : `${Math.round(size.width * safeMultiplier(size.width, size.height, options.scale))} × ${Math.round(size.height * safeMultiplier(size.width, size.height, options.scale))} px`}
              {clamped ? ` · ${t.dialog.downloadClamped}` : ''}
            </small>
          </div>
        ) : null}
        {format?.controls.quality ? <Slider label={t.dialog.downloadQuality} value={Math.round(options.quality * 100)} min={30} max={100} onChange={(v) => setOptions((o) => ({ ...o, quality: v / 100 }))} display={`${Math.round(options.quality * 100)}%`} /> : null}
        {format?.controls.transparent ? <Switch label={t.dialog.downloadTransparent} checked={options.transparent} onChange={(v) => setOptions((o) => ({ ...o, transparent: v }))} /> : null}

        <div className={styles.field} inert={videoLocked} style={videoLocked ? { opacity: 0.6 } : undefined}>
          <span>{t.dialog.downloadPages}</span>
          <Segmented
            label={t.dialog.downloadPages}
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: `${t.dialog.downloadAllPages} (${total})` },
              { value: 'current', label: t.dialog.downloadCurrentPage },
              { value: 'range', label: t.dialog.downloadRange },
            ]}
          />
          {scope === 'range' ? (
            <>
              <input className={styles.input} value={range} placeholder={t.dialog.downloadRangeHint} aria-label={t.dialog.downloadRange} aria-invalid={rangeInvalid} onChange={(e) => setRange(e.target.value)} />
              {rangeInvalid && range ? (
                <small className={styles.error} role="alert">
                  {t.dialog.downloadRangeInvalid}
                </small>
              ) : null}
            </>
          ) : null}
          {printing ? (
            <small className={printStyles.summary} data-testid="print-summary">
              {describeSizes(chosen, doc.unit)}
            </small>
          ) : null}
        </div>

        {printing ? <PrintSection settings={print} onChange={changePrint} sizes={chosen} unit={doc.unit} server={format?.server === true} /> : null}

        {video ? <AudioCredits /> : null}
        {video && format ? <LazyVideoSection format={format.id as VideoFormat} pages={chosenPages} rangeInvalid={rangeInvalid} footer={footerSlot} onLockChange={setVideoLocked} /> : null}

        {zipped ? <small className={styles.muted}>{t.dialog.downloadZip}</small> : null}

        <div className={styles.field} inert={videoLocked} style={videoLocked ? { opacity: 0.6 } : undefined}>
          <span>{t.dialog.downloadNames}</span>
          <Segmented
            label={t.dialog.downloadNames}
            value={nameStyle}
            onChange={setNameStyle}
            options={[
              { value: 'simple', label: t.dialog.downloadNamesSimple },
              { value: 'structured', label: t.dialog.downloadNamesStructured },
            ]}
          />
          {nameStyle === 'structured' ? <Switch label={t.dialog.downloadNamesTimestamp} checked={stamp === 'on'} onChange={(v) => setStamp(v ? 'on' : 'off')} /> : null}
          <small className={styles.muted} data-testid="download-filename">
            {t.dialog.downloadNamesExample(exampleName())}
          </small>
        </div>

        {busy ? (
          <div className={styles.field}>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)} aria-label={t.dialog.downloadWorking} className={styles.progress}>
              <div style={{ width: `${Math.max(4, (progress ?? 0) * 100)}%` }} />
            </div>
            {stage ? (
              <p className={printStyles.stage} role="status" data-testid="export-stage">
                {t.print.stage[stage]}
              </p>
            ) : null}
          </div>
        ) : null}
        {failure ? <ExportProblem key={failure.id} failure={failure.value} onRetry={() => void download()} /> : null}
      </div>
    </Dialog>
  )
}
