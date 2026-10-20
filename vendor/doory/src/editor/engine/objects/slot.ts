/**
 * Photo slots. A placeholder (an empty "add a photo" frame) becomes a picture that fills it: the frame stays put
 * and the picture moves inside it. The picture carries a `slot` describing the frame (centre, size, tilt and
 * crop shape) and is clipped to it by an absolutely positioned clip path, so panning and zooming never move the
 * frame. The picture can be panned, zoomed and turned but always keeps covering the frame, so no empty corner
 * is ever revealed (`clampSlotImage`). The frame can be restored with "reset to placeholder".
 *
 * The frame geometry is plain data (`SlotSpec`) and the clamp maths is pure, so both are unit tested without a canvas.
 */
import { Ellipse, type FabricImage, type FabricObject, Group, Path, Point, Polygon, Rect, type TMat2D, Triangle, util } from 'fabric'
import type { MaskShape, SlotSpec } from '@/types/document'
import { asDory } from './dory'
import { applySlotClip } from './masks'
import { PATH_SHAPES, maskPath, pointsToPath } from './shapeGeometry'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A usable `slot` from untrusted document JSON, or undefined (the picture then loads as an ordinary image). */
export function validSlot(raw: unknown): SlotSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const s = raw as Record<string, unknown>
  if (!isNum(s.cx) || !isNum(s.cy) || !isNum(s.width) || !isNum(s.height) || s.width <= 0 || s.height <= 0) return undefined
  const slot: SlotSpec = { cx: s.cx, cy: s.cy, width: Math.min(s.width, 40_000), height: Math.min(s.height, 40_000), angle: isNum(s.angle) ? s.angle : 0 }
  if (typeof s.mask === 'string' || (s.mask && typeof s.mask === 'object' && typeof (s.mask as { path?: unknown }).path === 'string')) slot.mask = s.mask as MaskShape
  if (isNum(s.radius)) slot.radius = Math.min(0.5, Math.max(0, s.radius))
  if (typeof s.src === 'string') slot.src = s.src
  return slot
}

/** A point rotated about the origin by `deg` degrees. */
export function rotatePoint(x: number, y: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

/** The four corners of the slot rectangle in page coordinates, tilt applied. */
export function slotCorners(slot: SlotSpec): { x: number; y: number }[] {
  const hw = slot.width / 2
  const hh = slot.height / 2
  return (
    [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ] as const
  ).map(([x, y]) => {
    const r = rotatePoint(x, y, slot.angle)
    return { x: slot.cx + r.x, y: slot.cy + r.y }
  })
}

export interface SlotImageState {
  /** Width and height of the picture before scaling (after cropping). */
  width: number
  height: number
  /** Rotation of the picture in degrees. */
  angle: number
  scaleX: number
  scaleY: number
  /** Centre of the picture in page coordinates. */
  cx: number
  cy: number
}

/**
 * The scale and centre that keep a picture covering its slot. The slot's corners are expressed in the picture's
 * own unrotated frame, where "covers" is an axis-aligned box test:
 *
 *  - the scale is lifted until the picture spans the slot on both of its axes (turning a photo therefore zooms
 *    it in as needed) and never shrinks below that;
 *  - the centre is clamped so every slot corner stays inside the picture.
 *
 * With both tilts at zero this reduces to comparing the picture's edges with the slot's.
 */
export function clampSlotTransform(slot: SlotSpec, img: SlotImageState): { scale: number; cx: number; cy: number } {
  const local = slotCorners(slot).map((pt) => rotatePoint(pt.x, pt.y, -img.angle))
  const xs = local.map((pt) => pt.x)
  const ys = local.map((pt) => pt.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const baseW = img.width || 1
  const baseH = img.height || 1
  const minScale = Math.max((maxX - minX) / baseW, (maxY - minY) / baseH)
  const requested = Math.max(Math.abs(img.scaleX || 1), Math.abs(img.scaleY || 1))
  const scale = Math.max(minScale, requested)
  const halfW = (baseW * scale) / 2
  const halfH = (baseH * scale) / 2
  const centre = rotatePoint(img.cx, img.cy, -img.angle)
  const x = Math.min(minX + halfW, Math.max(maxX - halfW, centre.x))
  const y = Math.min(minY + halfH, Math.max(maxY - halfH, centre.y))
  const back = rotatePoint(x, y, img.angle)
  return { scale, cx: back.x, cy: back.y }
}

/** The scale and centre of a picture that exactly covers the slot (cover fit, centred). */
export function coverSlotTransform(slot: SlotSpec, naturalWidth: number, naturalHeight: number): { scale: number; cx: number; cy: number } {
  return { scale: Math.max(slot.width / (naturalWidth || 1), slot.height / (naturalHeight || 1)), cx: slot.cx, cy: slot.cy }
}

/* ------------------------------------------------------------------------------------------------
 * Fabric glue
 * ---------------------------------------------------------------------------------------------- */

/** The crop shape implied by a placeholder object: its own mask, or its geometry (oval, rounded box, path, polygon). */
export function slotMaskOf(obj: FabricObject): { shape?: MaskShape; radius?: number } {
  const d = asDory(obj)
  if (d.maskShape) return { shape: d.maskShape, radius: d.maskRadius }
  if (obj instanceof Ellipse) return { shape: 'circle' }
  if (obj instanceof Rect && obj.rx > 0) return { shape: 'rounded', radius: Math.min(0.5, obj.rx / Math.max(1, Math.min(obj.width, obj.height))) }
  if (obj instanceof Triangle) return { shape: { path: 'M50 0 L100 100 L0 100 Z' } }
  if (obj instanceof Polygon) return { shape: { path: pointsToPath(obj.points) } }
  if (obj instanceof Path) {
    const known = d.shapeId ? PATH_SHAPES.find((s) => s.id === d.shapeId) : undefined
    return { shape: { path: known?.path ?? util.joinPath(obj.path) } }
  }
  return {}
}

/** Reads the frame (centre, unrotated size, tilt, crop shape) of a placeholder object. */
export function slotOf(obj: FabricObject, src?: string): SlotSpec {
  const c = obj.getCenterPoint()
  const mask = slotMaskOf(obj)
  const slot: SlotSpec = { cx: c.x, cy: c.y, width: obj.getScaledWidth(), height: obj.getScaledHeight(), angle: obj.angle || 0 }
  if (mask.shape) slot.mask = mask.shape
  if (mask.radius !== undefined) slot.radius = mask.radius
  if (src) slot.src = src
  return slot
}

export function hasSlot(obj: FabricObject | undefined | null): obj is FabricImage {
  return !!obj && asDory(obj).slot !== undefined
}

/** Keeps a slot picture covering its frame after any change of position, scale or rotation. */
export function clampSlotImage(img: FabricObject): void {
  const slot = asDory(img).slot
  if (!slot) return
  const c = img.getCenterPoint()
  const next = clampSlotTransform(slot, { width: img.width, height: img.height, angle: img.angle || 0, scaleX: img.scaleX, scaleY: img.scaleY, cx: c.x, cy: c.y })
  img.set({ scaleX: next.scale * (img.scaleX < 0 ? -1 : 1), scaleY: next.scale * (img.scaleY < 0 ? -1 : 1) })
  img.setPositionByOrigin(new Point(next.cx, next.cy), 'center', 'center')
  img.setCoords()
}

/** Moves a slot picture's frame together with the picture (duplicate and paste offsets). */
export function shiftSlot(obj: FabricObject, dx: number, dy: number): void {
  const d = asDory(obj)
  if (!d.slot) return
  d.slot = { ...d.slot, cx: d.slot.cx + dx, cy: d.slot.cy + dy }
  applySlotClip(obj)
}

/** Mirrors a picture's frame about a vertical (`horizontal` flip) or horizontal line, tilt included. */
export function mirrorSlot(obj: FabricObject, axis: 'horizontal' | 'vertical', line: number): void {
  const d = asDory(obj)
  if (!d.slot) return
  d.slot = axis === 'horizontal' ? { ...d.slot, cx: 2 * line - d.slot.cx, angle: -d.slot.angle || 0 } : { ...d.slot, cy: 2 * line - d.slot.cy, angle: -d.slot.angle || 0 }
  applySlotClip(obj)
  clampSlotImage(obj)
}

/**
 * The frame after the plane it lies in was transformed by `m` (move, turn, scale or mirror). A frame is a
 * rectangle, so it stays one under any similarity and under axis-aligned stretching; the crop shape is a
 * fraction of the frame and travels unchanged.
 */
export function transformSlot(slot: SlotSpec, m: TMat2D): SlotSpec {
  const c = new Point(slot.cx, slot.cy).transform(m)
  const rad = (slot.angle * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const ex = { x: m[0] * cos + m[2] * sin, y: m[1] * cos + m[3] * sin }
  const ey = { x: -m[0] * sin + m[2] * cos, y: -m[1] * sin + m[3] * cos }
  const turned = (Math.atan2(ex.y, ex.x) * 180) / Math.PI
  return { ...slot, cx: c.x, cy: c.y, width: slot.width * Math.hypot(ex.x, ex.y), height: slot.height * Math.hypot(ey.x, ey.y), angle: Math.round(turned * 1e6) / 1e6 || 0 }
}

/** The pictures inside a group or multi-selection (at any depth) that fill a placeholder. Moving the group moves them with it. */
export function carriedPictures(target: FabricObject | undefined): FabricImage[] {
  if (!(target instanceof Group)) return []
  return target.getObjects().flatMap((child) => (hasSlot(child) ? [child] : carriedPictures(child)))
}

/** A picture as it was when a whole-selection transform began. */
export interface FrameAnchor {
  picture: FabricObject
  matrix: TMat2D
  slot: SlotSpec
}

export function anchorFrames(pictures: FabricObject[]): FrameAnchor[] {
  return pictures.flatMap((picture) => {
    const slot = asDory(picture).slot
    return slot ? [{ picture, matrix: [...picture.calcTransformMatrix()] as TMat2D, slot }] : []
  })
}

/**
 * Brings the frames of pictures that were carried along by a transform of their group or selection to where the
 * pictures now are: the layout moves as one, a picture is only panned inside its frame when it is moved alone.
 */
export function followFrames(anchors: readonly FrameAnchor[]): void {
  for (const a of anchors) {
    const delta = util.multiplyTransformMatrices(a.picture.calcTransformMatrix(), util.invertTransform(a.matrix))
    asDory(a.picture).slot = transformSlot(a.slot, delta)
    applySlotClip(a.picture)
  }
}

/* ------------------------------------------------------------------------------------------------
 * Outline (editor overlay)
 * ---------------------------------------------------------------------------------------------- */

const pathBounds = new Map<string, { width: number; height: number; ox: number; oy: number }>()

function boundsOfPath(d: string): { width: number; height: number; ox: number; oy: number } {
  let b = pathBounds.get(d)
  if (!b) {
    const p = new Path(d)
    b = { width: p.width || 1, height: p.height || 1, ox: p.pathOffset.x, oy: p.pathOffset.y }
    pathBounds.set(d, b)
  }
  return b
}

/** SVG path data of a slot's crop shape, or null for the shapes drawn natively (rectangle, oval, rounded box). */
export function slotPathData(slot: SlotSpec): string | null {
  const m = slot.mask
  if (!m || m === 'circle' || m === 'rounded') return null
  return typeof m === 'string' ? maskPath(m) : m.path
}

/**
 * Strokes the slot's crop shape around the origin (the caller translates to the frame centre, rotates by the
 * frame's tilt and sets the line style). Used to draw the dashed placeholder outline in the shape the photo gets.
 */
export function strokeSlotOutline(ctx: CanvasRenderingContext2D, slot: SlotSpec): void {
  const hw = slot.width / 2
  const hh = slot.height / 2
  const d = slotPathData(slot)
  if (d && typeof Path2D === 'function') {
    const b = boundsOfPath(d)
    const sx = slot.width / b.width
    const sy = slot.height / b.height
    const shape = new Path2D()
    shape.addPath(new Path2D(d), new DOMMatrix([sx, 0, 0, sy, -b.ox * sx, -b.oy * sy]))
    ctx.stroke(shape)
    return
  }
  ctx.beginPath()
  if (slot.mask === 'circle') ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2)
  else if (slot.mask === 'rounded' && typeof ctx.roundRect === 'function') ctx.roundRect(-hw, -hh, slot.width, slot.height, Math.min(slot.width, slot.height) * (slot.radius ?? 0.18))
  else ctx.rect(-hw, -hh, slot.width, slot.height)
  ctx.stroke()
}
