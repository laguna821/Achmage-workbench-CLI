/**
 * Object effects: the document keeps a declarative `effects` object; this module maps it onto Fabric's
 * native props (shadow, stroke, paintFirst, textBackgroundColor) and back.
 */
import { type FabricObject, Shadow, type Textbox } from 'fabric'
import type { ObjectEffects, ShadowSpec } from '@/types/document'
import { asDory } from './dory'

export const DEFAULT_SHADOW: ShadowSpec = { color: '#00000066', blur: 12, offsetX: 4, offsetY: 6 }
export const DEFAULT_OUTLINE = { color: '#000000', width: 2 }
export const DEFAULT_GLOW = { color: '#7a64e0', blur: 18 }
export const DEFAULT_HIGHLIGHT = { color: '#fde047' }

function isText(obj: FabricObject): obj is Textbox {
  return /text/i.test(obj.constructor.name) || 'fontFamily' in obj
}

/** Writes `effects` to the object (and the native props it implies). Glow wins over shadow when both are set. */
export function applyEffects(obj: FabricObject, effects: ObjectEffects | undefined): void {
  const e = effects ?? {}
  asDory(obj).effects = Object.keys(e).length > 0 ? e : undefined

  if (e.glow) {
    obj.shadow = new Shadow({ color: e.glow.color, blur: e.glow.blur, offsetX: 0, offsetY: 0 })
  } else if (e.shadow) {
    obj.shadow = new Shadow({ ...e.shadow })
  } else {
    obj.shadow = null
  }

  if (isText(obj)) {
    if (e.outline) {
      obj.set({ stroke: e.outline.color, strokeWidth: e.outline.width, paintFirst: 'stroke', strokeLineJoin: 'round', strokeUniform: true })
    } else if (asDory(obj).shapeKind === undefined) {
      obj.set({ stroke: null, strokeWidth: 0 })
    }
    obj.set('textBackgroundColor', e.background ? e.background.color : '')
  }
  obj.set('dirty', true)
}

export function effectsOf(obj: FabricObject): ObjectEffects {
  return asDory(obj).effects ?? {}
}
