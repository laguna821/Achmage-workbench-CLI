import type { PageBackground } from '@/types/document'
import type { FillSpec } from '../engine/objects/fills'

/** The page background a colour/gradient fill stands for. */
export function fillToBackground(fill: FillSpec): PageBackground {
  return fill.type === 'solid' ? { type: 'solid', color: fill.color } : { type: 'gradient', kind: fill.kind, angle: fill.angle, stops: fill.stops }
}

/** The fill shown for a page background; image backgrounds have no colour and read as white. */
export function backgroundFill(bg: PageBackground): FillSpec {
  if (bg.type === 'solid') return { type: 'solid', color: bg.color }
  if (bg.type === 'gradient') return { type: 'gradient', kind: bg.kind, angle: bg.angle ?? 90, stops: bg.stops }
  return { type: 'solid', color: '#ffffff' }
}
