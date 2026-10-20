import { Clock } from 'lucide-react'
import { useRef, useState } from 'react'
import ed from '../chrome/ed.module.css'
import { useEditor, useEditorState } from '../context'
import { t } from '../strings'
import { Popover } from '../ui/Popover'
import { Tooltip } from '../ui/Tooltip'
import { DEFAULT_DURATION_SEC, DURATION_MAX_SEC, DURATION_MIN_SEC, formatDuration, hasTimings } from './timing'
import styles from './DurationChip.module.css'

interface DurationChipProps {
  pageId: string
  className?: string
}

/** `−  8  +` for whole seconds: typing applies a value in range at once, one outside is pulled back when the field is left. */
function SecondsStepper({ value, onChange }: { value: number; onChange: (sec: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (n: number): number => Math.min(DURATION_MAX_SEC, Math.max(DURATION_MIN_SEC, Math.round(n)))
  const commit = (raw: string): void => {
    setDraft(null)
    const n = Number(raw)
    if (raw.trim() !== '' && Number.isFinite(n)) onChange(clamp(n))
  }
  const hint = t.limits.range(DURATION_MIN_SEC, DURATION_MAX_SEC, t.pageTime.seconds)
  return (
    <div className={ed.stepper} role="group" aria-label={t.pageTime.field} title={hint}>
      <button type="button" className={ed.stepBtn} aria-label={t.pageTime.shorter} title={t.pageTime.shorter} disabled={value <= DURATION_MIN_SEC} data-testid="ed-time-minus" onClick={() => onChange(clamp(value - 1))}>
        −
      </button>
      <input
        type="number"
        className={ed.stepInput}
        aria-label={t.pageTime.field}
        title={hint}
        min={DURATION_MIN_SEC}
        max={DURATION_MAX_SEC}
        step={1}
        value={draft ?? value}
        data-testid="ed-time-input"
        onChange={(e) => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= DURATION_MIN_SEC && n <= DURATION_MAX_SEC) onChange(Math.round(n))
        }}
        onBlur={(e) => commit(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(e.currentTarget.value)
            e.currentTarget.blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            setDraft(null)
            onChange(clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)))
          }
        }}
      />
      <button type="button" className={ed.stepBtn} aria-label={t.pageTime.longer} title={t.pageTime.longer} disabled={value >= DURATION_MAX_SEC} data-testid="ed-time-plus" onClick={() => onChange(clamp(value + 1))}>
        +
      </button>
    </div>
  )
}

function TimePanel({ pageId, close }: { pageId: string; close: () => void }) {
  const editor = useEditor()
  const own = useEditorState((s) => s.doc.pages.find((p) => p.id === pageId)?.durationSec)
  const timed = useEditorState((s) => hasTimings(s.doc.pages))
  const set = typeof own === 'number'
  const shown = set ? own : DEFAULT_DURATION_SEC
  const hint = set ? t.pageTime.hintSet(formatDuration(own)) : timed ? t.pageTime.hintWaits : t.pageTime.hintDefault(formatDuration(DEFAULT_DURATION_SEC))
  return (
    <div className={styles.panel} role="group" aria-label={t.pageTime.title} data-testid="ed-time-pop">
      <p className={ed.sectionTitle}>{t.pageTime.title}</p>
      <div className={styles.row}>
        <SecondsStepper value={shown} onChange={(sec) => editor.pages.setDuration(pageId, sec)} />
        <span className={styles.unit}>{t.pageTime.seconds}</span>
      </div>
      <p className={styles.hint} data-testid="ed-time-hint">
        {hint}
      </p>
      <button
        type="button"
        className={`${ed.btn} ${ed.ghost} ${styles.wide}`}
        data-testid="ed-time-all"
        onClick={() => {
          editor.pages.setDurationAll(shown)
          editor.announce(t.pageTime.appliedAll(formatDuration(shown)))
        }}
      >
        {t.pageTime.applyAll}
      </button>
      <button
        type="button"
        className={`${ed.btn} ${ed.ghost} ${styles.wide}`}
        disabled={!set}
        data-testid="ed-time-none"
        onClick={() => {
          editor.pages.setDuration(pageId, null)
          editor.announce(t.pageTime.cleared)
          close()
        }}
      >
        {t.pageTime.none}
      </button>
    </div>
  )
}

/**
 * The time a page stays up when a presentation advances by itself: a clock chip in the page header (and in the notes
 * bar) that opens the seconds stepper, "Apply to all pages" and "No auto-advance". In view-only and comment-only
 * editors it only shows a time that is set.
 */
export function DurationChip({ pageId, className }: DurationChipProps) {
  const readOnly = useEditorState((s) => s.readOnly)
  const own = useEditorState((s) => s.doc.pages.find((p) => p.id === pageId)?.durationSec)
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const set = typeof own === 'number'
  const label = set ? formatDuration(own) : null
  const cls = `${styles.chip} ${className ?? ''}`
  if (readOnly) {
    return label ? (
      <span className={cls} role="img" aria-label={t.pageTime.chipReadOnly(label)} data-testid="ed-time-chip">
        <Clock size={12} aria-hidden="true" />
        {label}
      </span>
    ) : null
  }
  const name = label ? t.pageTime.chipSet(label) : t.pageTime.chipUnset
  return (
    <>
      <Tooltip label={name} disabled={open}>
        <button ref={ref} type="button" className={cls} data-unset={set ? undefined : ''} aria-label={name} aria-haspopup="dialog" aria-expanded={open} data-testid="ed-time-chip" onClick={() => setOpen((o) => !o)}>
          <Clock size={12} aria-hidden="true" />
          {label}
        </button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} label={t.pageTime.title} placement="bottom-start" variant="plain" cover gap={8} focusOnOpen>
        <TimePanel pageId={pageId} close={() => setOpen(false)} />
      </Popover>
    </>
  )
}
