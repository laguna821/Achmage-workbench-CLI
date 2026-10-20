/**
 * "Resize design" content mapping, operating purely on serialised objects.
 *
 *  - `magic`   : proportionally repositions and scales content. Each object keeps its relative
 *                position on the page, is scaled uniformly (so nothing is distorted) and is clamped to
 *                stay inside the new page. Full-bleed objects (backgrounds) are stretched to cover.
 *  - `scale`   : scales everything uniformly to fit and centres the result (letterbox).
 *  - `keep`    : only changes the page size; objects stay exactly where they are.
 */
import type { DocObject, DocPage, DoryDocument, PageBackground, PageGuide, SlotSpec } from '@/types/document'
import { clampSize, findPageIndex, pageSize } from './docOps'
import { rotatedBounds } from './geometry'
import { normalizeSizes } from './pageSizes'

export type ResizeMode = 'magic' | 'scale' | 'keep'

interface Origin {
  x: number
  y: number
}

const ORIGIN_FACTOR: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }

const num = (o: DocObject, key: string, fallback: number): number => {
  const v = o[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Unrotated, scaled size of an object (stroke excluded). */
function objectSize(o: DocObject): { w: number; h: number } {
  return { w: Math.abs(num(o, 'width', 0) * num(o, 'scaleX', 1)), h: Math.abs(num(o, 'height', 0) * num(o, 'scaleY', 1)) }
}

function originOf(o: DocObject): { ox: number; oy: number } {
  const ox = ORIGIN_FACTOR[typeof o.originX === 'string' ? o.originX : 'center'] ?? 0.5
  const oy = ORIGIN_FACTOR[typeof o.originY === 'string' ? o.originY : 'center'] ?? 0.5
  return { ox, oy }
}

/** Centre of an object in page coordinates (rotation about its origin point is accounted for). */
export function objectCenter(o: DocObject): Origin {
  const { w, h } = objectSize(o)
  const { ox, oy } = originOf(o)
  const a = (num(o, 'angle', 0) * Math.PI) / 180
  const dx = (0.5 - ox) * w
  const dy = (0.5 - oy) * h
  return {
    x: num(o, 'left', 0) + dx * Math.cos(a) - dy * Math.sin(a),
    y: num(o, 'top', 0) + dx * Math.sin(a) + dy * Math.cos(a),
  }
}

function setCenter(o: DocObject, center: Origin, w: number, h: number): void {
  const { ox, oy } = originOf(o)
  const a = (num(o, 'angle', 0) * Math.PI) / 180
  const dx = (0.5 - ox) * w
  const dy = (0.5 - oy) * h
  o.left = center.x - (dx * Math.cos(a) - dy * Math.sin(a))
  o.top = center.y - (dx * Math.sin(a) + dy * Math.cos(a))
}

function scaleShadow(shadow: unknown, k: number): unknown {
  if (!shadow || typeof shadow !== 'object') return shadow
  const s = shadow as Record<string, unknown>
  const scaled: Record<string, unknown> = { ...s }
  for (const key of ['blur', 'offsetX', 'offsetY']) {
    if (typeof s[key] === 'number') scaled[key] = (s[key] as number) * k
  }
  return scaled
}

/** Scales an object uniformly by `k` about its own origin point (does not move the origin point). */
function scaleObjectBy(o: DocObject, k: number): void {
  const isText = typeof o.type === 'string' && /text/i.test(o.type)
  if (isText && !o.path && num(o, 'scaleX', 1) === 1 && num(o, 'scaleY', 1) === 1) {
    o.fontSize = num(o, 'fontSize', 16) * k
    o.width = num(o, 'width', 0) * k
    if (typeof o.height === 'number') o.height = o.height * k
    if (typeof o.fitFontSize === 'number') o.fitFontSize = o.fitFontSize * k
    if (o.fit && typeof o.fit === 'object') {
      const f = o.fit as Record<string, unknown>
      if (typeof f.minFontSize === 'number') o.fit = { ...f, minFontSize: Math.max(4, Math.round(f.minFontSize * k)) }
    }
  } else {
    o.scaleX = num(o, 'scaleX', 1) * k
    o.scaleY = num(o, 'scaleY', 1) * k
  }
  if (typeof o.strokeWidth === 'number' && o.strokeUniform === true) o.strokeWidth = o.strokeWidth * k
  if (o.shadow) o.shadow = scaleShadow(o.shadow, k)
}

/** Moves and scales a placeholder photo's frame rigidly with its picture (same centre move, same scale `k`). */
function mapSlot(slot: SlotSpec, from: Origin, to: Origin, k: number): SlotSpec {
  return { ...slot, cx: to.x + (slot.cx - from.x) * k, cy: to.y + (slot.cy - from.y) * k, width: slot.width * k, height: slot.height * k }
}

function mapObject(src: DocObject, from: { w: number; h: number }, to: { w: number; h: number }, mode: ResizeMode): DocObject {
  if (mode === 'keep') return src
  const o = structuredClone(src)
  const sx = to.w / from.w
  const sy = to.h / from.h
  const { w, h } = objectSize(o)
  const center = objectCenter(o)

  if (mode === 'scale') {
    const k = Math.min(sx, sy)
    const offX = (to.w - from.w * k) / 2
    const offY = (to.h - from.h * k) / 2
    scaleObjectBy(o, k)
    const moved = { x: center.x * k + offX, y: center.y * k + offY }
    setCenter(o, moved, w * k, h * k)
    if (isSlot(o.slot)) o.slot = mapSlot(o.slot, center, moved, k)
    return o
  }

  // magic
  const bounds = rotatedBounds(center.x, center.y, w, h, num(o, 'angle', 0))
  const coversPage = bounds.width * bounds.height >= 0.85 * from.w * from.h && bounds.width >= 0.9 * from.w && bounds.height >= 0.9 * from.h
  let k = Math.min(sx, sy)
  let nextCenter: Origin = { x: center.x * sx, y: center.y * sy }
  if (coversPage) {
    k = Math.max(sx, sy)
    nextCenter = { x: to.w / 2, y: to.h / 2 }
  }
  scaleObjectBy(o, k)
  const nw = w * k
  const nh = h * k
  if (!coversPage) {
    const nb = rotatedBounds(nextCenter.x, nextCenter.y, nw, nh, num(o, 'angle', 0))
    if (nb.width <= to.w) {
      if (nb.left < 0) nextCenter.x += -nb.left
      else if (nb.left + nb.width > to.w) nextCenter.x -= nb.left + nb.width - to.w
    }
    if (nb.height <= to.h) {
      if (nb.top < 0) nextCenter.y += -nb.top
      else if (nb.top + nb.height > to.h) nextCenter.y -= nb.top + nb.height - to.h
    }
  }
  setCenter(o, nextCenter, nw, nh)
  if (isSlot(o.slot)) o.slot = mapSlot(o.slot, center, nextCenter, k)
  return o
}

function isSlot(v: unknown): v is SlotSpec {
  return !!v && typeof v === 'object' && typeof (v as SlotSpec).cx === 'number' && typeof (v as SlotSpec).width === 'number'
}

/** Rescales an offsetting image background when the page size changes. */
function mapBackground(bg: PageBackground, from: { w: number; h: number }, to: { w: number; h: number }): PageBackground {
  if (bg.type !== 'image') return bg
  const k = Math.min(to.w / from.w, to.h / from.h)
  return {
    ...bg,
    ...(bg.offsetX !== undefined ? { offsetX: bg.offsetX * (to.w / from.w) } : {}),
    ...(bg.offsetY !== undefined ? { offsetY: bg.offsetY * (to.h / from.h) } : {}),
    ...(bg.scale !== undefined ? { scale: bg.scale * k } : {}),
  }
}

/** Ruler guides follow the content: scaled with it, and dropped when the new page no longer reaches them. */
function mapGuides(guides: readonly PageGuide[], from: { w: number; h: number }, to: { w: number; h: number }, mode: ResizeMode): PageGuide[] {
  if (mode === 'keep') return guides.filter((g) => g.pos < (g.orientation === 'vertical' ? to.w : to.h))
  const k = Math.min(to.w / from.w, to.h / from.h)
  const offX = mode === 'scale' ? (to.w - from.w * k) / 2 : 0
  const offY = mode === 'scale' ? (to.h - from.h * k) / 2 : 0
  const mapped = guides.map((g): PageGuide => {
    if (g.orientation === 'vertical') return { ...g, pos: Math.round(mode === 'scale' ? g.pos * k + offX : g.pos * (to.w / from.w)) }
    return { ...g, pos: Math.round(mode === 'scale' ? g.pos * k + offY : g.pos * (to.h / from.h)) }
  })
  return mapped.filter((g) => g.pos > 0 && g.pos < (g.orientation === 'vertical' ? to.w : to.h))
}

export function resizePageContent(page: DocPage, from: { w: number; h: number }, to: { w: number; h: number }, mode: ResizeMode): DocPage {
  const next: DocPage = {
    ...page,
    background: mapBackground(page.background, from, to),
    objects: page.objects.map((o) => mapObject(o, from, to, mode)),
  }
  if (page.guides) {
    const guides = mapGuides(page.guides, from, to, mode)
    if (guides.length > 0) next.guides = guides
    else delete next.guides
  }
  return next
}

/**
 * Resizes one page to `width` x `height`, remapping its content per `mode`; the other pages keep their sizes. The
 * document comes back in canonical form (the document size follows the first page).
 */
export function resizePage(doc: DoryDocument, pageId: string, width: number, height: number, mode: ResizeMode): DoryDocument {
  const index = findPageIndex(doc, pageId)
  if (index < 0) return doc
  const page = doc.pages[index]
  const old = pageSize(doc, page)
  const w = clampSize(width)
  const h = clampSize(height)
  if (old.width === w && old.height === h) return doc
  const resized: DocPage = { ...resizePageContent(page, { w: old.width, h: old.height }, { w, h }, mode), width: w, height: h }
  const pages = doc.pages.slice()
  pages[index] = resized
  return normalizeSizes({ ...doc, pages })
}

/** Resizes the whole document (every page) to `width` x `height`, remapping content per `mode`. */
export function resizeDocument(doc: DoryDocument, width: number, height: number, mode: ResizeMode): DoryDocument {
  const w = clampSize(width)
  const h = clampSize(height)
  const pages = doc.pages.map((page) => {
    const old = pageSize(doc, page)
    const next = resizePageContent(page, { w: old.width, h: old.height }, { w, h }, mode)
    const cleared: DocPage = { ...next }
    delete cleared.width
    delete cleared.height
    return cleared
  })
  return { ...doc, width: w, height: h, pages }
}
