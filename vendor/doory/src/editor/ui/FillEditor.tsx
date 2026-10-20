import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { GradientStop } from '@/types/document'
import { type FillSpec, DEFAULT_STOPS, gradientCss, sortStops } from '../engine/objects/fills'
import { t } from '../strings'
import { Button } from './Button'
import { ColorPicker } from './ColorPicker'
import { NumberField } from './NumberField'
import { Segmented } from './Segmented'
import { GRADIENT_PRESETS } from './swatches'
import styles from './FillEditor.module.css'

interface FillEditorProps {
  value: FillSpec
  onChange: (fill: FillSpec) => void
  /** Hide the gradient tab (strokes, text effects). */
  solidOnly?: boolean
  extraSwatches?: { label: string; colors: readonly string[] }
}

type Mode = 'solid' | 'linear' | 'radial'

function modeOf(v: FillSpec): Mode {
  return v.type === 'solid' ? 'solid' : v.kind
}

/** Solid colour or linear/radial gradient with a draggable stop editor. */
export function FillEditor({ value, onChange, solidOnly, extraSwatches }: FillEditorProps) {
  const [selected, setSelected] = useState(0)
  const mode = modeOf(value)

  const setMode = (next: Mode): void => {
    if (next === 'solid') {
      onChange({ type: 'solid', color: value.type === 'solid' ? value.color : (sortStops(value.stops)[0]?.color ?? '#000000') })
      return
    }
    if (value.type === 'gradient') {
      onChange({ ...value, kind: next })
      return
    }
    const base = value.color
    onChange({ type: 'gradient', kind: next, angle: 90, stops: [{ offset: 0, color: base }, { offset: 1, color: DEFAULT_STOPS[1].color }] })
    setSelected(0)
  }

  return (
    <div className={styles.editor}>
      {solidOnly ? null : (
        <Segmented
          label={t.fill.type}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'solid', label: t.panels.solid },
            { value: 'linear', label: t.fill.linear },
            { value: 'radial', label: t.fill.radial },
          ]}
        />
      )}
      {value.type === 'solid' ? (
        <ColorPicker value={value.color} onChange={(color) => onChange({ type: 'solid', color })} extraSwatches={extraSwatches} />
      ) : (
        <GradientEditor value={value} selected={selected} onSelect={setSelected} onChange={onChange} extraSwatches={extraSwatches} />
      )}
    </div>
  )
}

function GradientEditor({
  value,
  selected,
  onSelect,
  onChange,
  extraSwatches,
}: {
  value: Extract<FillSpec, { type: 'gradient' }>
  selected: number
  onSelect: (i: number) => void
  onChange: (fill: FillSpec) => void
  extraSwatches?: { label: string; colors: readonly string[] }
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const stops = value.stops
  const index = Math.min(selected, stops.length - 1)
  const update = (next: GradientStop[]): void => onChange({ ...value, stops: next })

  const startDrag = (i: number) => (e: React.PointerEvent): void => {
    e.stopPropagation()
    onSelect(i)
    const bar = barRef.current
    if (!bar) return
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      const r = bar.getBoundingClientRect()
      const offset = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
      update(stops.map((s, j) => (j === i ? { ...s, offset: Math.round(offset * 100) / 100 } : s)))
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  const addStop = (e: React.PointerEvent): void => {
    const bar = barRef.current
    if (!bar || stops.length >= 8) return
    const r = bar.getBoundingClientRect()
    const offset = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const sorted = sortStops(stops)
    const before = [...sorted].reverse().find((s) => s.offset <= offset) ?? sorted[0]
    const next = [...stops, { offset: Math.round(offset * 100) / 100, color: before.color }]
    update(next)
    onSelect(next.length - 1)
  }

  const onStopKey = (i: number) => (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const delta = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.1 : 0.02)
      update(stops.map((s, j) => (j === i ? { ...s, offset: Math.min(1, Math.max(0, Math.round((s.offset + delta) * 100) / 100)) } : s)))
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && stops.length > 2) {
      e.preventDefault()
      update(stops.filter((_, j) => j !== i))
    }
  }

  return (
    <div className={styles.gradient}>
      <div className={styles.presets} role="group" aria-label={t.fill.presets}>
        {GRADIENT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={styles.preset}
            style={{ background: gradientCss({ type: 'gradient', kind: value.kind, angle: p.angle, stops: p.stops }) }}
            aria-label={p.label}
            title={p.label}
            onClick={() => onChange({ ...value, angle: p.angle, stops: p.stops })}
          />
        ))}
      </div>
      <div ref={barRef} className={styles.bar} onPointerDown={addStop} style={{ background: gradientCss({ type: 'gradient', kind: 'linear', angle: 0, stops: value.stops }) }}>
        {stops.map((s, i) => (
          <button
            key={i}
            type="button"
            className={`${styles.stop} ${i === index ? styles.stopOn : ''}`}
            style={{ left: `${s.offset * 100}%`, background: s.color }}
            aria-label={t.fill.stop(i + 1, Math.round(s.offset * 100))}
            onPointerDown={startDrag(i)}
            onKeyDown={onStopKey(i)}
            onFocus={() => onSelect(i)}
          />
        ))}
      </div>
      <div className={styles.controls}>
        {value.kind === 'linear' ? <NumberField label={t.fill.angle} value={value.angle} min={0} max={359} step={1} suffix="°" showLabel onChange={(angle) => onChange({ ...value, angle })} width={120} /> : <span />}
        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={stops.length <= 2} onClick={() => update(stops.filter((_, j) => j !== index))} aria-label={t.fill.removeStopLabel}>
          {t.fill.removeStop}
        </Button>
      </div>
      <ColorPicker value={stops[index]?.color ?? '#000000'} onChange={(color) => update(stops.map((s, j) => (j === index ? { ...s, color } : s)))} extraSwatches={extraSwatches} />
    </div>
  )
}
