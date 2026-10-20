/**
 * The trim editor of a track: the waveform of the whole file with two handles that choose the part that plays. Dragging
 * with a pointer, the arrow keys (a tenth of a second; Shift: a second) and Home / End all work; every move is
 * `editor.audio.update` with a shared undo key, so a drag is one undo step.
 */
import { useCallback, useRef } from 'react'
import type { AudioTrack } from '@/types/document'
import { useEditor } from '../context'
import { MIN_TRIM_MS, clampNumber, trimmedLengthMs } from '../audio/model'
import { useWaveform } from '../audio/useWaveform'
import { formatTime } from '../animation/timelineMath'
import { t } from '../strings'
import { AudioWaveform } from './AudioWaveform'
import styles from './Audio.module.css'

type Edge = 'start' | 'end'

const STEP_MS = 100
const FINE = 10

export function AudioTrimmer({ track, readOnly, sourceMs }: { track: AudioTrack; readOnly: boolean; sourceMs: number }) {
  const editor = useEditor()
  const wave = useWaveform(track)
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ edge: Edge; id: number } | null>(null)
  const total = Math.max(sourceMs, track.trimEndMs, 1)
  const pct = (ms: number): number => (ms / total) * 100

  const move = useCallback(
    (edge: Edge, ms: number, key: string): void => {
      const target = Math.round(ms / FINE) * FINE
      if (edge === 'start') editor.audio.update(track.id, { trimStartMs: clampNumber(target, 0, track.trimEndMs - MIN_TRIM_MS) }, t.audio.history.trim, key)
      else editor.audio.update(track.id, { trimEndMs: clampNumber(target, track.trimStartMs + MIN_TRIM_MS, total) }, t.audio.history.trim, key)
    },
    [editor, track.id, track.trimStartMs, track.trimEndMs, total],
  )

  const timeAt = (clientX: number): number => {
    const rect = box.current?.getBoundingClientRect()
    return rect ? clampNumber(((clientX - rect.left) / Math.max(1, rect.width)) * total, 0, total) : 0
  }

  const onKey = (edge: Edge) => (e: React.KeyboardEvent): void => {
    if (readOnly) return
    const amount = e.shiftKey ? 1000 : STEP_MS
    const current = edge === 'start' ? track.trimStartMs : track.trimEndMs
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = current - amount
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = current + amount
    else if (e.key === 'Home') next = edge === 'start' ? 0 : track.trimStartMs + MIN_TRIM_MS
    else if (e.key === 'End') next = edge === 'start' ? track.trimEndMs - MIN_TRIM_MS : total
    if (next === null) return
    e.preventDefault()
    move(edge, next, `audio-trim-key:${track.id}:${edge}`)
  }

  const handle = (edge: Edge) => {
    const value = edge === 'start' ? track.trimStartMs : track.trimEndMs
    const label = edge === 'start' ? t.audio.tracks.trimStart : t.audio.tracks.trimEnd
    return (
      <div
        className={styles.trimHandle}
        data-edge={edge}
        data-testid={`audio-trim-${edge}`}
        role="slider"
        tabIndex={readOnly ? -1 : 0}
        aria-label={label}
        aria-valuemin={edge === 'start' ? 0 : track.trimStartMs + MIN_TRIM_MS}
        aria-valuemax={edge === 'start' ? track.trimEndMs - MIN_TRIM_MS : total}
        aria-valuenow={value}
        aria-valuetext={formatTime(value, true)}
        aria-readonly={readOnly || undefined}
        style={{ left: `${pct(value)}%` }}
        onKeyDown={onKey(edge)}
        onPointerDown={(e) => {
          if (readOnly || e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { edge, id: e.pointerId }
          editor.sealHistory()
        }}
        onPointerMove={(e) => {
          if (drag.current?.edge === edge && drag.current.id === e.pointerId) move(edge, timeAt(e.clientX), `audio-trim:${track.id}:${edge}`)
        }}
        onPointerUp={(e) => {
          if (drag.current?.id === e.pointerId) {
            drag.current = null
            editor.sealHistory()
          }
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <span className={styles.trimGrip} aria-hidden="true" />
      </div>
    )
  }

  return (
    <div className={styles.trimmer}>
      <div ref={box} className={styles.trimBox}>
        <AudioWaveform peaks={wave.peaks} name={track.name} loading={wave.status === 'loading'} height={56} selectFromMs={track.trimStartMs} selectToMs={track.trimEndMs} />
        <span className={styles.trimShade} style={{ left: 0, width: `${pct(track.trimStartMs)}%` }} aria-hidden="true" />
        <span className={styles.trimShade} style={{ left: `${pct(track.trimEndMs)}%`, right: 0 }} aria-hidden="true" />
        {handle('start')}
        {handle('end')}
      </div>
      <p className={styles.trimReadout} data-testid="audio-trim-readout">
        {t.audio.tracks.trimmed(formatTime(track.trimStartMs, true), formatTime(track.trimEndMs, true), `${(trimmedLengthMs(track) / 1000).toFixed(1)} s`)}
      </p>
    </div>
  )
}
