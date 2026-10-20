/**
 * The timeline on a narrow screen: a list of the animated elements with a chip for each animation, and a slider for
 * the playhead. Touching an element selects it; the times themselves are set in the Animate panel.
 */
import { LogIn, LogOut, Sparkles } from 'lucide-react'
import { useEditor } from '../context'
import type { AnimSlot } from '../animation/model'
import { usePlaybackValue } from '../animation/playback'
import { objectName, presetLabel, slotLabel } from '../animation/labels'
import type { TimelineSection } from '../animation/sections'
import { type Lane, formatTime } from '../animation/timelineMath'
import { t } from '../strings'
import styles from './Timeline.module.css'

const SLOT_ICON = { enter: LogIn, exit: LogOut, emphasis: Sparkles } as const

interface ListProps {
  lanes: readonly Lane[]
  sections: readonly TimelineSection[]
  pageId: string
  readOnly: boolean
  selected: ReadonlySet<string>
  lengthMs: number
  onScrub(ms: number, phase: 'start' | 'move' | 'end'): void
}

export function TimelineList({ lanes, sections, pageId, readOnly, selected, lengthMs, onScrub }: ListProps) {
  const editor = useEditor()
  const time = usePlaybackValue((s) => s.timeMs)
  return (
    <div className={styles.list}>
      <input
        type="range"
        className={styles.scrub}
        aria-label={t.animation.timeline.scrub}
        min={0}
        max={Math.round(lengthMs)}
        step={100}
        value={Math.round(Math.min(time, lengthMs))}
        aria-valuetext={formatTime(time, true)}
        data-testid="tl-scrub"
        onPointerDown={() => onScrub(time, 'start')}
        onChange={(e) => onScrub(Number(e.target.value), 'move')}
        onPointerUp={() => onScrub(0, 'end')}
        onKeyUp={() => onScrub(0, 'end')}
      />
      <ul className={styles.items} aria-label={t.animation.timeline.list}>
        {lanes.map((lane) => {
          const name = objectName(lane.object)
          return (
            <li key={lane.object.id} className={styles.item} data-selected={selected.has(lane.object.id) || undefined}>
              <button type="button" className={styles.itemName} aria-pressed={selected.has(lane.object.id)} onClick={() => editor.select([lane.object.id])}>
                {name}
              </button>
              <span className={styles.chips}>
                {lane.spans.map((span) => {
                  const Icon = SLOT_ICON[span.slot as AnimSlot]
                  const text = t.animation.timeline.chip(slotLabel(span.slot), presetLabel(span.slot, span.anim.preset), formatTime(span.startMs, true), formatTime(span.endMs, true))
                  return (
                    <button key={span.slot} type="button" className={styles.chip} data-slot={span.slot} title={text} aria-label={text} onClick={() => editor.select([lane.object.id])}>
                      <Icon size={12} aria-hidden="true" />
                      <span>{presetLabel(span.slot, span.anim.preset)}</span>
                    </button>
                  )
                })}
              </span>
            </li>
          )
        })}
      </ul>
      {sections.map((section) => (section.List ? <section.List key={section.id} pageId={pageId} readOnly={readOnly} /> : null))}
    </div>
  )
}
