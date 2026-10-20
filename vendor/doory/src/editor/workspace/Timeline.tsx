/**
 * The timeline under the workspace: the animations of the active page on a time axis, a transport (play, pause,
 * repeat, speed, the playhead's time), the page's own time and a warning when animations outlast it. On a narrow screen
 * the axis becomes a list. The playhead and the preview over the page are one thing (`animation/playback.ts`).
 */
import { ChevronDown, ChevronUp, Film, Pause, Play, Repeat, SkipBack, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useEditor, useEditorState, useEditorStateShallow } from '../context'
import { playbackOf, SPEEDS, usePlaybackValue } from '../animation/playback'
import { LABEL_WIDTH, MAX_ZOOM, fittingDurationSec, formatSeconds, formatTime, lanesOf, overrunOf, pageMarkerMs, previewLengthMs } from '../animation/timelineMath'
import { pageSpans } from '../animation/model'
import { timelineSections } from '../animation/sections'
import { DurationChip } from '../presenter/DurationChip'
import { useElementSize } from '../presenter/useElementSize'
import { t } from '../strings'
import { Button, IconButton } from '../ui/Button'
import { Select } from '../ui/Select'
import { TimelineList } from './TimelineList'
import { TimelineTracks } from './TimelineTracks'
import { setTimelineView, useTimelineView } from './timelineVisibility'
import styles from './Timeline.module.css'

/** Below this width of the timeline the lanes become a list. */
const COMPACT_BELOW = 560
const ZOOM_STEP = 1.5

function Readout({ lengthMs }: { lengthMs: number }) {
  const time = usePlaybackValue((s) => s.timeMs)
  return (
    <span className={styles.readout} role="timer" aria-label={t.animation.timeline.time(formatTime(time, true), formatTime(lengthMs, true))} data-testid="tl-readout">
      <span>{formatTime(time, true)}</span>
      <span className={styles.readoutTotal}> / {formatTime(lengthMs, true)}</span>
    </span>
  )
}

/** The timeline of the active page. Rendered by `TimelineHost` while the timeline is open. */
function Timeline() {
  const editor = useEditor()
  const playback = playbackOf(editor)
  const { collapsed } = useTimelineView()
  const page = useEditorState((s) => s.doc.pages.find((p) => p.id === s.activePageId) ?? s.doc.pages[0])
  const readOnly = useEditorState((s) => s.readOnly)
  const selectedIds = useEditorStateShallow((s) => s.selection.ids)
  const playing = usePlaybackValue((s) => s.playing)
  const loop = usePlaybackValue((s) => s.loop)
  const speed = usePlaybackValue((s) => s.speed)
  const [ref, size] = useElementSize<HTMLElement>()
  const [zoom, setZoom] = useState(1)
  const wasPlaying = useRef(false)

  const lanes = useMemo(() => lanesOf(page), [page])
  const spans = useMemo(() => pageSpans(page), [page])
  const sections = useSyncExternalStore(timelineSections.subscribe, timelineSections.getSnapshot)
  // A section may keep its content beside the pages (the audio tracks): follow the document, so its extent is asked again.
  useEditorState((s) => s.doc)
  const ownLengthMs = useMemo(() => previewLengthMs(page), [page])
  const lengthMs = Math.max(ownLengthMs, ...sections.map((s) => s.extentMs?.(page, editor) ?? 0))
  const marker = useMemo(() => pageMarkerMs(page), [page])
  const overrun = useMemo(() => overrunOf(page), [page])
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const compact = size.width > 0 && size.width < COMPACT_BELOW
  const empty = lanes.length === 0 && !sections.some((s) => s.hasContent?.(page, editor))

  // Scrubbing holds the clock while the playhead is dragged and lets it go on afterwards.
  const scrub = (ms: number, phase: 'start' | 'move' | 'end'): void => {
    if (phase === 'end') {
      if (wasPlaying.current) playback.play(lengthMs)
      wasPlaying.current = false
      return
    }
    if (phase === 'start') {
      wasPlaying.current = playback.state.playing
      playback.pause()
    }
    playback.seek(ms, lengthMs)
  }

  // A selection made on the canvas brings its lane into view.
  useEffect(() => {
    const id = selectedIds[0]
    if (!id) return
    const lane = ref.current?.querySelector<HTMLElement>(`[data-testid="tl-lane-${CSS.escape(id)}"]`)
    lane?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIds, ref])

  return (
    <section ref={ref} className={`${styles.timeline} ${compact ? styles.compact : ''}`} aria-label={t.animation.timeline.region} data-collapsed={collapsed || undefined} data-testid="ed-timeline">
      <header className={styles.head} data-playback-controls>
        <IconButton label={playing ? t.animation.timeline.pause : t.animation.timeline.play} size="sm" tooltipSide="top" shortcut="Space" disabled={empty} pressed={playing} onClick={() => playback.toggle(lengthMs)} data-testid="tl-play">
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </IconButton>
        <IconButton label={t.animation.timeline.restart} size="sm" tooltipSide="top" disabled={empty} onClick={() => playback.seek(0, lengthMs)} data-testid="tl-restart">
          <SkipBack size={16} />
        </IconButton>
        <IconButton label={t.animation.timeline.loop} size="sm" tooltipSide="top" pressed={loop} onClick={() => playback.setLoop(!loop)} data-testid="tl-loop">
          <Repeat size={16} />
        </IconButton>
        <Readout lengthMs={lengthMs} />
        {compact ? null : (
          <label className={styles.speed}>
            <span className={styles.srOnly}>{t.animation.timeline.speed}</span>
            <Select aria-label={t.animation.timeline.speed} value={String(speed)} onChange={(e) => playback.setSpeed(SPEEDS.find((s) => String(s) === e.target.value) ?? 1)} data-testid="tl-speed">
              {SPEEDS.map((s) => (
                <option key={s} value={String(s)}>
                  {t.animation.timeline.speedOption(s)}
                </option>
              ))}
            </Select>
          </label>
        )}
        <span className={styles.spacer} />
        {overrun && !readOnly ? (
          <span className={styles.warning} role="status" data-testid="tl-overrun">
            <span>{t.animation.timeline.overrun(formatSeconds(overrun.overMs))}</span>
            <Button size="sm" variant="soft" onClick={() => editor.pages.setDuration(page.id, fittingDurationSec(page))} data-testid="tl-extend">
              {t.animation.timeline.extend}
            </Button>
          </span>
        ) : overrun ? (
          <span className={styles.warning} role="status">
            {t.animation.timeline.overrun(formatSeconds(overrun.overMs))}
          </span>
        ) : null}
        <DurationChip pageId={page.id} />
        {compact || collapsed || empty ? null : (
          <>
            <IconButton label={t.animation.timeline.zoomOut} size="sm" tooltipSide="top" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / ZOOM_STEP))} data-testid="tl-zoom-out">
              <ZoomOut size={16} />
            </IconButton>
            <IconButton label={t.animation.timeline.zoomIn} size="sm" tooltipSide="top" disabled={zoom >= MAX_ZOOM} onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))} data-testid="tl-zoom-in">
              <ZoomIn size={16} />
            </IconButton>
          </>
        )}
        <IconButton label={collapsed ? t.animation.timeline.expand : t.animation.timeline.collapse} size="sm" tooltipSide="top" onClick={() => setTimelineView(editor, { collapsed: !collapsed })} data-testid="tl-collapse">
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </IconButton>
        <IconButton label={t.animation.timeline.close} size="sm" tooltipSide="top" onClick={() => setTimelineView(editor, { open: false })} data-testid="tl-close">
          <X size={16} />
        </IconButton>
      </header>
      {collapsed ? null : empty ? (
        <div className={styles.empty} data-testid="tl-empty">
          <Film size={20} aria-hidden="true" />
          <p>{t.animation.timeline.empty}</p>
          <p className={styles.emptyHint}>{t.animation.timeline.emptyHint}</p>
          {readOnly ? null : (
            <Button size="sm" variant="soft" onClick={() => editor.patchUi({ panelId: 'animate' })}>
              {t.animation.timeline.openPanel}
            </Button>
          )}
        </div>
      ) : compact ? (
        <TimelineList lanes={lanes} sections={sections} pageId={page.id} readOnly={readOnly} selected={selected} lengthMs={lengthMs} onScrub={scrub} />
      ) : (
        <TimelineTracks
          lanes={lanes}
          sections={sections}
          pageId={page.id}
          spans={spans}
          trackWidth={Math.max(120, size.width - LABEL_WIDTH - 16)}
          lengthMs={lengthMs}
          zoom={zoom}
          readOnly={readOnly}
          selected={selected}
          marker={marker}
          overrun={overrun}
          onScrub={scrub}
        />
      )}
    </section>
  )
}

/** Renders the timeline while it is switched on (the Timeline button of the pages pill, the More menu or `Shift+T`). */
export function TimelineHost() {
  return useTimelineView().open ? <Timeline /> : null
}
