/**
 * Mask frames for images and placeholders. A `maskShape` is rebuilt into a Fabric `clipPath` in the
 * object's local coordinate space (origin at the centre), so it follows crops, scales and flips.
 */
import { type FabricObject, Ellipse, Path, Rect } from 'fabric'
import type { MaskShape, SlotSpec } from '@/types/document'
import { asDory } from './dory'
import { maskPath } from './shapeGeometry'

export const DEFAULT_MASK_RADIUS = 0.18

/** Corner radius of a `rounded` mask as a fraction of the shorter side (0..0.5). */
export function maskRadiusOf(obj: FabricObject): number {
  const r = asDory(obj).maskRadius
  return typeof r === 'number' ? Math.min(0.5, Math.max(0, r)) : DEFAULT_MASK_RADIUS
}

export function buildClipPath(shape: MaskShape, width: number, height: number, radiusFraction = DEFAULT_MASK_RADIUS): FabricObject {
  const common = { originX: 'center' as const, originY: 'center' as const, left: 0, top: 0 }
  if (shape === 'circle') return new Ellipse({ ...common, rx: width / 2, ry: height / 2 })
  if (shape === 'rounded') {
    const r = Math.min(width, height) * radiusFraction
    return new Rect({ ...common, width, height, rx: r, ry: r })
  }
  const d = typeof shape === 'string' ? maskPath(shape) : shape.path
  if (!d) return new Rect({ ...common, width, height })
  const path = new Path(d, { ...common, objectCaching: false })
  const w = path.width || 100
  const h = path.height || 100
  path.set({ scaleX: width / w, scaleY: height / h })
  return path
}

/** The clip path of a placeholder photo's frame: the crop shape laid out in page coordinates around the frame centre. */
export function buildSlotClip(slot: SlotSpec): FabricObject {
  const clip = buildClipPath(slot.mask ?? 'rounded', slot.width, slot.height, slot.mask ? (slot.radius ?? DEFAULT_MASK_RADIUS) : 0)
  clip.set({ originX: 'center', originY: 'center', left: slot.cx, top: slot.cy, angle: slot.angle, absolutePositioned: true })
  return clip
}

/** (Re)builds the absolute clip of a picture that has a slot. */
export function applySlotClip(obj: FabricObject): void {
  const slot = asDory(obj).slot
  obj.clipPath = slot ? buildSlotClip(slot) : undefined
  obj.set('dirty', true)
}

/** Rebuilds (or removes) the clip path of `obj` from its `maskShape`. */
export function applyMask(obj: FabricObject): void {
  // A picture in a placeholder frame is clipped to the frame, which stays put (see slot.ts).
  if (asDory(obj).slot) {
    applySlotClip(obj)
    return
  }
  const shape = asDory(obj).maskShape
  if (!shape) {
    obj.clipPath = undefined
  } else {
    obj.clipPath = buildClipPath(shape, obj.width, obj.height, maskRadiusOf(obj))
  }
  obj.set('dirty', true)
}
