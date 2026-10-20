import { Download, Film } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocPage } from '@/types/document'
import { isAudible, readTracks } from '../../audio/model'
import { useEditor, useEditorState } from '../../context'
import { type Capabilities, type FormatSupport, detectCapabilities } from '../../engine/export/video/codecs'
import { GIF_WARN_BYTES, estimateOutput, formatBytes, formatLength } from '../../engine/export/video/estimate'
import { downloadFiles } from '../../engine/export/exporter'
import { frameSize } from '../../engine/export/video/geometry'
import { FORMAT_RULES, type VideoFormat, type VideoOptions, withFormat } from '../../engine/export/video/options'
import { compileTimeline } from '../../engine/export/video/timeline'
import { getPageSize } from '../../engine/pageSizes'
import { t } from '../../strings'
import { Button } from '../../ui/Button'
import { VideoForm } from './VideoForm'
import { VideoProgress } from './VideoProgress'
import { VideoResult } from './VideoResult'
import { loadVideoSettings, saveVideoSettings } from './videoSettings'
import { useVideoJob } from './useVideoJob'
import styles from './video.module.css'

export interface VideoSectionProps {
  format: VideoFormat
  /** The pages the dialog's page choice selects, in document order. */
  pages: { page: DocPage; index: number }[]
  /** The page range the person typed cannot be read. */
  rangeInvalid: boolean
  /** Where the buttons go: the dialog's footer. */
  footer: HTMLElement | null
  /** True while an export runs or a finished file is shown: the dialog holds its own choices still. */
  onLockChange: (locked: boolean) => void
}

const FORMAT_LABEL: Record<VideoFormat, string> = { mp4: 'MP4', webm: 'WebM', gif: 'GIF' }

/** The notes about what this browser will do, from the capability table (`codecs.ts`). */
function engineNotes(format: VideoFormat, support: FormatSupport | null, caps: Capabilities | null): { text: string; warn: boolean }[] {
  const e = t.video.engine
  if (format === 'gif') return [{ text: e.gif, warn: false }]
  if (!caps || !support) return []
  if (support.engine === null) return [{ text: e.none, warn: true }]
  if (support.engine === 'recorder') return [{ text: e.recorder, warn: true }]
  const notes = [{ text: e.webcodecs(support.video ?? '', support.audio), warn: false }]
  if (support.notes.includes('video-fallback')) notes.push({ text: e.videoFallback(support.video ?? ''), warn: true })
  if (support.notes.includes('audio-fallback')) notes.push({ text: e.audioFallback, warn: true })
  if (support.notes.includes('no-audio')) notes.push({ text: e.noAudio, warn: true })
  return notes
}

/**
 * The video and GIF part of the Download dialog (loaded on demand, see `VideoSectionLoader`): settings, what the file
 * will be (length, size, how this browser makes it), then progress, and a preview of the result with Download. The
 * dialog's footer buttons are drawn into `footer`, so they belong to the state this component holds.
 */
export function VideoSection({ format, pages, rangeInvalid, footer, onLockChange }: VideoSectionProps) {
  const editor = useEditor()
  const doc = useEditorState((s) => s.doc)
  const { state, start, cancel, reset } = useVideoJob(editor)
  const [stored, setStored] = useState<VideoOptions>(() => loadVideoSettings(editor.designId, format))
  const options = stored.format === format ? stored : withFormat(stored, format)
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const downloadRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const makeRef = useRef<HTMLButtonElement>(null)
  const problemRef = useRef<HTMLDivElement>(null)
  const previous = useRef(state.phase)
  const p = t.video

  useEffect(() => {
    let alive = true
    void detectCapabilities().then((found) => {
      if (alive) setCaps(found)
    })
    return () => {
      alive = false
    }
  }, [])

  const working = state.phase === 'working'
  const done = state.phase === 'done'
  useEffect(() => {
    onLockChange(working || done)
    return () => onLockChange(false)
  }, [working, done, onLockChange])
  // Keyboard focus follows the file's life: Cancel while it works, Download when it is ready, the main button when the
  // settings come back (the button that had it is gone), and the message when something went wrong.
  useEffect(() => {
    const before = previous.current
    previous.current = state.phase
    if (state.phase === 'working') cancelRef.current?.focus()
    else if (state.phase === 'done') downloadRef.current?.focus()
    else if (state.phase === 'failed') problemRef.current?.scrollIntoView?.({ block: 'nearest' })
    else if (before === 'working' || before === 'done') makeRef.current?.focus()
  }, [state.phase])

  const change = (patch: Partial<VideoOptions>): void => {
    const next = { ...options, ...patch }
    setStored(next)
    saveVideoSettings(editor.designId, next)
  }

  const sized = useMemo(() => pages.map((ref) => ({ ...ref, size: getPageSize(doc, ref.page.id) })), [pages, doc])
  const timeline = useMemo(() => compileTimeline(sized, { pageSeconds: options.pageSeconds }), [sized, options.pageSeconds])
  const first = sized[0]?.size ?? getPageSize(doc, editor.state.activePageId)
  const frame = frameSize(first, options.resolution, format)
  const hasSound = useMemo(() => readTracks(doc).some(isAudible), [doc])
  const support: FormatSupport | null = format === 'gif' ? { engine: 'webcodecs', video: 'GIF', audio: null, notes: [] } : caps ? caps[format] : null
  const canEncodeSound = support?.audio != null
  const withSound = format !== 'gif' && options.audio && hasSound && canEncodeSound
  const estimate = estimateOutput(timeline, options, frame, withSound)
  const mixedShapes = sized.some((s) => Math.abs(s.size.width / s.size.height - first.width / first.height) > 0.01)
  const notes = engineNotes(format, support, caps)
  const ready = !rangeInvalid && sized.length > 0 && !estimate.tooLong && support !== null && support.engine !== null
  const gif = format === 'gif'
  const limit = FORMAT_RULES[format].maxMs / 60_000

  const make = (): void => {
    saveVideoSettings(editor.designId, options)
    void start({ pages, options })
  }

  const download = (): void => {
    if (state.phase !== 'done') return
    downloadFiles([{ blob: state.result.blob, filename: state.result.filename }])
    editor.toast(p.downloadStarted, 'success')
  }

  let body: ReactNode
  let actions: ReactNode
  if (state.phase === 'working') {
    body = <VideoProgress progress={state.progress} />
    actions = (
      <>
        <Button ref={cancelRef} onClick={cancel} data-testid="video-cancel">
          {p.cancel}
        </Button>
        <span className={styles.footerSpacer} />
        <Button variant="primary" icon={<Film size={16} />} disabled>
          {t.dialog.downloadWorking}
        </Button>
      </>
    )
  } else if (state.phase === 'done') {
    body = <VideoResult result={state.result} url={state.url} />
    actions = (
      <>
        <Button onClick={reset} data-testid="video-again">
          {p.changeSettings}
        </Button>
        <span className={styles.footerSpacer} />
        <Button ref={downloadRef} variant="primary" icon={<Download size={16} />} onClick={download} data-testid="video-download">
          {p.download}
        </Button>
      </>
    )
  } else {
    body = (
      <fieldset className={styles.section} data-testid="video-section" data-format={format}>
        <legend>{p.section(FORMAT_LABEL[format])}</legend>
        {support === null ? (
          <p className={styles.checking} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            {p.checking}
          </p>
        ) : (
          <>
            <VideoForm options={options} onChange={change} frame={frame} hasSound={hasSound} canEncodeSound={canEncodeSound} mixedShapes={mixedShapes} />
            <div className={styles.summary} data-testid="video-summary">
              <p className={styles.summaryLine} data-testid="video-estimate" data-bytes={estimate.bytes} data-ms={estimate.durationMs}>
                {sized.length === 0 ? p.warnings.noPages : p.summary(formatLength(estimate.durationMs), estimate.frames, formatBytes(estimate.bytes))}
              </p>
              <p className={styles.hint}>{p.estimate}</p>
            </div>
            <ul className={styles.notes} data-testid="video-notes">
              {estimate.tooLong ? (
                <li className={styles.warning} role="alert">
                  {p.warnings.tooLong(`${limit} minutes`)}
                </li>
              ) : null}
              {gif && estimate.bytes > GIF_WARN_BYTES ? (
                <li className={styles.warning} role="alert" data-testid="video-gif-warning">
                  {p.warnings.gifLarge(formatBytes(estimate.bytes))}
                </li>
              ) : null}
              {notes.map((note) => (
                <li key={note.text} className={note.warn ? styles.warning : styles.note}>
                  {note.text}
                </li>
              ))}
            </ul>
          </>
        )}
        {state.phase === 'failed' ? (
          <div ref={problemRef} className={styles.problem} role="alert" data-testid="video-problem" data-code={state.failure.code}>
            <p>{state.failure.message}</p>
            <p className={styles.problemHint}>{state.failure.hint}</p>
            {state.failure.detail ? (
              <details>
                <summary>{p.problems.detail}</summary>
                {state.failure.detail}
              </details>
            ) : null}
          </div>
        ) : null}
      </fieldset>
    )
    actions = (
      <>
        <span className={styles.footerSpacer} />
        <Button ref={makeRef} variant="primary" icon={<Film size={16} />} onClick={make} disabled={!ready} data-testid="video-make">
          {state.phase === 'failed' && state.failure.retryable ? p.problems.retry : gif ? p.makeGif : p.makeVideo}
        </Button>
      </>
    )
  }

  return (
    <>
      {body}
      {footer ? createPortal(actions, footer) : null}
    </>
  )
}
