/** The settings of one animation in the Animate panel: direction, times, easing, strength, text unit and repeat. */
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ZoomIn, ZoomOut } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Anim, AnimDirection, AnimEasing, AnimTextUnit } from '@/types/document'
import { EASINGS } from '../animation/easing'
import { DELAY_RANGE, DURATION_RANGE, type AnimSlot, TEXT_UNITS } from '../animation/model'
import { directionsOf, supportsTextUnits } from '../animation/ops'
import { t } from '../strings'
import { NumberField } from '../ui/NumberField'
import { Segmented } from '../ui/Segmented'
import { Select } from '../ui/Select'
import { Slider } from '../ui/Slider'
import { Switch } from '../ui/Switch'
import styles from './Animate.module.css'

const COPY = t.animation.panel

/** An arrow points the way the element travels: from the left it moves right. */
const DIRECTION_ICON: Record<AnimDirection, ReactNode> = {
  left: <ArrowRight size={14} aria-hidden="true" />,
  right: <ArrowLeft size={14} aria-hidden="true" />,
  up: <ArrowDown size={14} aria-hidden="true" />,
  down: <ArrowUp size={14} aria-hidden="true" />,
  in: <ZoomIn size={14} aria-hidden="true" />,
  out: <ZoomOut size={14} aria-hidden="true" />,
}

const seconds = (ms: number): number => Math.round(ms / 100) / 10

interface SettingsProps {
  slot: AnimSlot
  anim: Anim
  /** The selection has text, so a text animation can step through its units. */
  hasText: boolean
  onPatch(patch: Partial<Anim>, field: string): void
}

export function AnimateSettings({ slot, anim, hasText, onPatch }: SettingsProps) {
  const directions = directionsOf(slot, anim.preset)
  const names = slot === 'exit' ? COPY.directionTo : COPY.directionFrom
  const showUnits = hasText && supportsTextUnits(slot, anim.preset)
  const units = TEXT_UNITS.map((value) => ({ value, label: COPY.units[value] }))
  return (
    <div className={styles.settings} data-testid="animate-settings">
      {directions.length > 1 ? (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{COPY.direction}</span>
          <Segmented<AnimDirection>
            label={COPY.direction}
            iconOnly
            value={anim.direction ?? directions[0]}
            options={directions.map((d) => ({ value: d, label: names[d], icon: DIRECTION_ICON[d] }))}
            onChange={(direction) => onPatch({ direction }, 'direction')}
          />
        </div>
      ) : null}
      <div className={styles.pair}>
        <NumberField
          label={COPY.duration}
          showLabel
          value={seconds(anim.durationMs)}
          min={DURATION_RANGE.min / 1000}
          max={DURATION_RANGE.max / 1000}
          step={0.1}
          decimals={1}
          suffix={COPY.seconds}
          hint={COPY.durationHint}
          onChange={(v) => onPatch({ durationMs: Math.round(v * 1000) }, 'duration')}
        />
        <NumberField
          label={COPY.delay}
          showLabel
          value={seconds(anim.delayMs)}
          min={DELAY_RANGE.min / 1000}
          max={DELAY_RANGE.max / 1000}
          step={0.1}
          decimals={1}
          suffix={COPY.seconds}
          hint={COPY.delayHint}
          onChange={(v) => onPatch({ delayMs: Math.round(v * 1000) }, 'delay')}
        />
      </div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{COPY.easing}</span>
        <Select aria-label={COPY.easing} value={anim.easing} data-testid="animate-easing" onChange={(e) => onPatch({ easing: e.target.value as AnimEasing }, 'easing')}>
          {EASINGS.map((easing) => (
            <option key={easing} value={easing}>
              {COPY.easings[easing]}
            </option>
          ))}
        </Select>
      </label>
      <Slider label={COPY.intensity} min={0} max={100} step={5} value={Math.round((anim.intensity ?? 0.5) * 100)} display={`${Math.round((anim.intensity ?? 0.5) * 100)}%`} onChange={(v) => onPatch({ intensity: v / 100 }, 'intensity')} />
      {showUnits ? (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{COPY.by}</span>
          <Segmented<AnimTextUnit> label={COPY.by} value={anim.by ?? 'object'} options={units} onChange={(by) => onPatch({ by: by === 'object' ? undefined : by }, 'by')} />
        </div>
      ) : null}
      {slot === 'emphasis' ? <Switch label={COPY.loop} hint={COPY.loopHint} checked={anim.loop === true} onChange={(loop) => onPatch({ loop: loop ? true : undefined }, 'loop')} /> : null}
    </div>
  )
}
