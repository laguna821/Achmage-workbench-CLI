/** Names shown for animations in the timeline and the panel. */
import type { DocObject } from '@/types/document'
import { kindOfDoc } from '../engine/objects/kinds'
import { t } from '../strings'
import type { AnimSlot } from './model'
import { emphasisPresets, inOutPresets } from './presets'

export function slotLabel(slot: AnimSlot): string {
  return t.animation.timeline.slot[slot]
}

/** The name of a preset, or its id when it is not registered (a document from the future). */
export function presetLabel(slot: AnimSlot, id: string): string {
  return (slot === 'emphasis' ? emphasisPresets.get(id) : inOutPresets.get(id))?.label ?? id
}

/** The name a layer goes by in the layers panel: its name, a snippet of its text, or its kind. */
export function objectName(object: DocObject): string {
  const kind = kindOfDoc(object)
  if (typeof object.name === 'string' && object.name.trim()) return object.name
  if (kind === 'text' && typeof object.text === 'string' && object.text.trim()) return object.text.replace(/\s+/g, ' ').slice(0, 40)
  return t.kinds[kind as keyof typeof t.kinds] ?? t.kinds.object
}
