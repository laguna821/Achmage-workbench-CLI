/**
 * The vocabulary of the co-editing fuzz harness: a seeded design and a catalogue of document edits that mirror what
 * the editor can do (move, resize, group, restyle, text, pages, sizes, notes, animation, templates, ...).
 *
 * Every edit is plain data (`Step`): which peer acts, which kind of edit and a few integers that are resolved
 * against the document *as that peer sees it* (modulo what exists), so a script keeps its meaning when the shrinker
 * removes steps around it. Ids of new objects come from the step's own number, never from a counter that depends on
 * what ran before.
 */
import { createBlankDocument } from '@/lib/document'
import type { Anim, AudioTrack, DocObject, DocPage, DoryDocument, ObjectAnimation, PageBackground } from '@/types/document'
import { normalizeTransition } from '../../animation/model'
import { emphasisPresets, inOutPresets, transitionPresets } from '../../animation/presets'
import '../../animation/builtins'
import { newTransition, withPatch, withPreset, withoutSlot } from '../../animation/ops'
import { applyTemplate } from '../../panels/templateOps'
import { setAllDurations, setPageDuration, setPageNotes } from '../../presenter/pageProps'
import { addPage, duplicatePage, movePage, removePage, renamePage, setPageBackground, applyBackgroundToAll } from '../../engine/docOps'
import { type ResizeMode, resizeDocument, resizePage } from '../../engine/magicResize'
import { newPageSize, normalizeSizes, sameSize, getPageSize } from '../../engine/pageSizes'
import { moveId, reorderIds } from '../../engine/zorder'
import { Random } from '../testing'

type AnimSlotName = 'enter' | 'exit' | 'emphasis'

export const OP_KINDS = [
  'move',
  'moveTo',
  'scale',
  'setSize',
  'rotate',
  'flip',
  'skew',
  'delete',
  'duplicate',
  'group',
  'ungroup',
  'zorder',
  'reorder',
  'lock',
  'hide',
  'rename',
  'fill',
  'stroke',
  'opacity',
  'shadow',
  'effects',
  'filters',
  'mask',
  'textEdit',
  'textStyle',
  'insertShape',
  'insertText',
  'insertImage',
  'fillPlaceholder',
  'animate',
  'pageAdd',
  'pageDuplicate',
  'pageRemove',
  'pageMove',
  'pageRename',
  'pageBackground',
  'pageBackgroundAll',
  'pageResize',
  'resizeDesign',
  'unit',
  'bleed',
  'guides',
  'notes',
  'duration',
  'durationAll',
  'transition',
  'template',
  'audioAdd',
  'audioEdit',
  'audioRemove',
  'future',
] as const

export type OpKind = (typeof OP_KINDS)[number]

export type StepKind = 'op' | 'undo' | 'redo' | 'seal' | 'flush' | 'send' | 'recv' | 'dup' | 'swap' | 'offline' | 'online' | 'join' | 'restore'

/** One thing that happens in a fuzz run. All numbers are small non-negative integers. */
export interface Step {
  /** The peer it happens to. */
  p: number
  k: StepKind
  op?: OpKind
  a: number
  b: number
  c: number
  d: number
  /** A number unique in the script: the ids of whatever the step creates derive from it. */
  n: number
  /** Milliseconds the clock advances before the step (so coalescing windows open and close). */
  dt: number
}

/* ------------------------------------------------------------------------------------------------
 * A seeded design
 * ------------------------------------------------------------------------------------------------ */

export const COLORS = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#1c1517', '#ffffff'] as const
const FONTS = ['Inter, sans-serif', 'Georgia, serif', 'Courier New, monospace', 'Arial Black, sans-serif'] as const
const WORDS = ['Summer', 'sale', 'Grüße', '你好', '🎨', 'Doory', 'new', 'été', 'ünï', 'line\nbreak', '—', '50%'] as const
const SHAPES = ['rect', 'ellipse', 'triangle', 'circle'] as const
const MASKS = ['circle', 'rounded', 'triangle', 'diamond', 'hexagon', 'star', 'heart', 'blob', 'arch', 'cross'] as const
const FILTER_TYPES = ['brightness', 'contrast', 'saturation', 'hue', 'blur', 'vignette', 'grayscale', 'sepia'] as const
const SIZES: readonly (readonly [number, number])[] = [
  [800, 600],
  [1080, 1080],
  [1240, 1754],
  [1920, 1080],
  [595, 842],
]

const num = (n: number, low: number, span: number): number => low + (n % span)

function shapeProps(r: Random, id: string, w: number, h: number): DocObject {
  const type = r.pick(SHAPES)
  const base: DocObject = {
    id,
    type,
    left: r.int(Math.max(1, w - 100)) + 50,
    top: r.int(Math.max(1, h - 100)) + 50,
    width: 40 + r.int(200),
    height: 40 + r.int(200),
    fill: r.pick(COLORS),
    stroke: r.pick(COLORS),
    strokeWidth: r.int(6),
    opacity: 1,
    angle: r.int(4) === 0 ? r.int(360) : 0,
    scaleX: 1,
    scaleY: 1,
    originX: 'center',
    originY: 'center',
  }
  if (r.int(3) === 0) base.name = `Layer ${id}`
  if (r.int(4) === 0) base.shadow = { color: '#00000066', blur: r.int(20), offsetX: r.int(10), offsetY: r.int(10) }
  return base
}

function textProps(r: Random, id: string, w: number, h: number): DocObject {
  const text = Array.from({ length: 1 + r.int(4) }, () => r.pick(WORDS)).join(' ')
  const out: DocObject = {
    id,
    type: 'textbox',
    left: r.int(Math.max(1, w - 200)) + 100,
    top: r.int(Math.max(1, h - 100)) + 50,
    width: 160 + r.int(300),
    height: 60,
    text,
    fontSize: 16 + r.int(60),
    fontFamily: r.pick(FONTS),
    fontWeight: r.pick(['normal', 700, 400]),
    fill: r.pick(COLORS),
    textAlign: r.pick(['left', 'center', 'right']),
    originX: 'center',
    originY: 'center',
    angle: 0,
    scaleX: 1,
    scaleY: 1,
  }
  if (r.bool()) out.styles = [{ start: 0, end: Math.min(2, text.length), style: { fill: r.pick(COLORS), fontWeight: 700 } }]
  return out
}

function imageProps(r: Random, id: string, w: number, h: number): DocObject {
  const placeholder = r.int(3) === 0
  const out: DocObject = {
    id,
    type: 'image',
    left: r.int(Math.max(1, w - 200)) + 100,
    top: r.int(Math.max(1, h - 200)) + 100,
    width: 100 + r.int(200),
    height: 100 + r.int(200),
    src: placeholder ? '/media/sample.png' : `/media/img-${r.int(5)}.png`,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
    originX: 'center',
    originY: 'center',
  }
  if (placeholder) {
    out.isPlaceholder = true
    out.slot = { cx: out.left, cy: out.top, width: out.width, height: out.height, angle: 0, mask: r.pick(MASKS) }
  } else if (r.bool()) {
    out.filters = [{ type: r.pick(FILTER_TYPES), value: r.int(100) / 100 }]
  }
  return out
}

function groupOf(r: Random, id: string, w: number, h: number): DocObject {
  const children: DocObject[] = [shapeProps(r, `${id}-a`, 200, 200), textProps(r, `${id}-b`, 200, 200)]
  return { id, type: 'group', left: r.int(Math.max(1, w - 200)) + 100, top: r.int(Math.max(1, h - 200)) + 100, width: 200, height: 200, scaleX: 1, scaleY: 1, angle: 0, originX: 'center', originY: 'center', objects: children }
}

function objectOf(r: Random, id: string, w: number, h: number): DocObject {
  switch (r.int(6)) {
    case 0:
      return textProps(r, id, w, h)
    case 1:
      return imageProps(r, id, w, h)
    case 2:
      return groupOf(r, id, w, h)
    default:
      return shapeProps(r, id, w, h)
  }
}

/** A design with one to three pages of two to six objects, some with their own size, notes or timing. */
export function makeSeedDoc(seed: number, prefix = 's'): DoryDocument {
  const r = new Random(seed * 7919 + 13)
  const [w, h] = r.pick(SIZES)
  const doc = createBlankDocument(w, h)
  const pages: DocPage[] = []
  const count = 1 + r.int(3)
  for (let i = 0; i < count; i++) {
    const pid = `${prefix}p${i}`
    const objects = Array.from({ length: 2 + r.int(5) }, (_, j) => objectOf(r, `${prefix}${i}-${j}`, w, h))
    const page: DocPage = { id: pid, background: { type: 'solid', color: r.pick(COLORS) }, objects }
    if (i > 0 && r.int(3) === 0) {
      const [pw, ph] = r.pick(SIZES)
      page.width = pw
      page.height = ph
    }
    if (r.int(3) === 0) page.name = `Page ${i + 1}`
    if (r.int(4) === 0) page.notes = 'Speaker notes — grüße'
    if (r.int(4) === 0) page.durationSec = 3 + r.int(10)
    pages.push(page)
  }
  return normalizeSizes({ ...doc, meta: r.int(3) === 0 ? { presetId: 'a4' } : undefined, pages })
}

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------------------------------ */

interface Edit {
  doc: DoryDocument
  label: string
  key?: string
}

function mapPage(doc: DoryDocument, pi: number, fn: (page: DocPage) => DocPage): DoryDocument {
  const page = doc.pages[pi]
  const next = fn(page)
  if (next === page) return doc
  const pages = doc.pages.slice()
  pages[pi] = next
  return { ...doc, pages }
}

function mapObject(doc: DoryDocument, pi: number, oi: number, fn: (o: DocObject) => DocObject): DoryDocument {
  return mapPage(doc, pi, (page) => {
    const o = page.objects[oi]
    const next = fn(o)
    if (next === o) return page
    const objects = page.objects.slice()
    objects[oi] = next
    return { ...page, objects }
  })
}

function without<T extends object>(o: T, ...keys: string[]): T {
  const out = { ...o } as Record<string, unknown>
  for (const key of keys) delete out[key]
  return out as T
}

/** The page and object the numbers `a` and `b` point to, or null when the page has no objects. */
function pick(doc: DoryDocument, a: number, b: number): { pi: number; oi: number; object: DocObject } | null {
  const candidates = doc.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.objects.length > 0)
  if (candidates.length === 0) return null
  const { p, i } = candidates[a % candidates.length]
  const oi = b % p.objects.length
  return { pi: i, oi, object: p.objects[oi] }
}

const isText = (o: DocObject): boolean => /text/i.test(o.type)
const isImage = (o: DocObject): boolean => o.type === 'image'
const num0 = (o: DocObject, key: string, fallback = 0): number => (typeof o[key] === 'number' ? (o[key] as number) : fallback)

function pickWhere(doc: DoryDocument, a: number, b: number, test: (o: DocObject) => boolean): { pi: number; oi: number; object: DocObject } | null {
  const all: { pi: number; oi: number; object: DocObject }[] = []
  doc.pages.forEach((page, pi) => page.objects.forEach((object, oi) => test(object) && all.push({ pi, oi, object })))
  void b
  return all.length === 0 ? null : all[a % all.length]
}

function solid(n: number): string {
  return COLORS[n % COLORS.length]
}

function backgroundOf(a: number, b: number): PageBackground {
  switch (a % 3) {
    case 0:
      return { type: 'solid', color: solid(b) }
    case 1:
      return { type: 'gradient', kind: b % 2 === 0 ? 'linear' : 'radial', angle: b % 360, stops: [{ offset: 0, color: solid(b) }, { offset: 1, color: solid(b + 3) }] }
    default:
      return { type: 'image', src: `/media/bg-${b % 4}.png`, fit: (['cover', 'contain', 'tile'] as const)[b % 3], opacity: 0.5 + (b % 5) / 10 }
  }
}

/** A deterministic stand-in for random JSON of a property no feature of the editor knows about. */
function futureValue(seed: number): unknown {
  return new Random(seed + 1).json(2)
}

function boundsOf(objects: readonly DocObject[]): { left: number; top: number; width: number; height: number } {
  const left = Math.min(...objects.map((o) => num0(o, 'left')))
  const top = Math.min(...objects.map((o) => num0(o, 'top')))
  const right = Math.max(...objects.map((o) => num0(o, 'left') + num0(o, 'width', 10)))
  const bottom = Math.max(...objects.map((o) => num0(o, 'top') + num0(o, 'height', 10)))
  return { left, top, width: right - left, height: bottom - top }
}

function reidTree(o: DocObject, base: string): DocObject {
  let counter = 0
  const walk = (node: DocObject): DocObject => {
    const copy: DocObject = { ...node, id: `${base}${counter === 0 ? '' : `-${counter}`}` }
    counter += 1
    if (Array.isArray(node.objects)) copy.objects = (node.objects as DocObject[]).map(walk)
    return copy
  }
  return walk(o)
}

/** Replaces `crypto.randomUUID` by a counter while `run` is going, so `newId()` gives the same ids on every run. */
export async function withRepeatableIds<T>(run: () => Promise<T>): Promise<T> {
  const original = crypto.randomUUID.bind(crypto)
  let counter = 0
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, writable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` })
  try {
    return await run()
  } finally {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, writable: true, value: original })
  }
}

/* ------------------------------------------------------------------------------------------------
 * The catalogue
 * ------------------------------------------------------------------------------------------------ */

type OpFn = (doc: DoryDocument, s: Step) => Edit | null

function onObject(label: string, key: string | undefined, change: (o: DocObject, s: Step) => DocObject, test?: (o: DocObject) => boolean): OpFn {
  return (doc, s) => {
    const hit = test ? pickWhere(doc, s.a, s.b, test) : pick(doc, s.a, s.b)
    if (!hit) return null
    return { doc: mapObject(doc, hit.pi, hit.oi, (o) => change(o, s)), label, key: key ? `${key}:${hit.object.id}` : undefined }
  }
}

function pageOf(doc: DoryDocument, n: number): { pi: number; page: DocPage } {
  const pi = n % doc.pages.length
  return { pi, page: doc.pages[pi] }
}

const LOCK_PROPS = ['lockMovementX', 'lockMovementY', 'lockScalingX', 'lockScalingY', 'lockRotation'] as const

function presetIds(slot: AnimSlotName): string[] {
  return (slot === 'emphasis' ? emphasisPresets.list() : inOutPresets.list()).map((p) => p.id)
}

const catalogue: Record<OpKind, OpFn> = {
  move: onObject('Move', 'move', (o, s) => ({ ...o, left: num0(o, 'left') + (s.c % 61) - 30, top: num0(o, 'top') + (s.d % 61) - 30 })),
  moveTo: onObject('Position', 'pos', (o, s) => ({ ...o, left: num(s.c, 0, 900), top: num(s.d, 0, 900) })),
  scale: onObject('Resize', 'scale', (o, s) => ({ ...o, scaleX: 0.5 + (s.c % 200) / 100, scaleY: 0.5 + (s.d % 200) / 100 })),
  setSize: onObject('Size', 'size', (o, s) => ({ ...o, width: num(s.c, 10, 500), height: num(s.d, 10, 500) })),
  rotate: onObject('Rotate', 'rotate', (o, s) => ({ ...o, angle: s.c % 360 })),
  flip: onObject('Flip', undefined, (o, s) => (s.c % 2 === 0 ? { ...o, flipX: o.flipX !== true } : { ...o, flipY: o.flipY !== true })),
  skew: onObject('Skew', 'skew', (o, s) => ({ ...o, skewX: s.c % 30, skewY: s.d % 30 })),
  delete: (doc, s) => {
    const hit = pick(doc, s.a, s.b)
    if (!hit) return null
    const second = s.c % 3 === 0 ? doc.pages[hit.pi].objects[(hit.oi + 1) % doc.pages[hit.pi].objects.length] : null
    const gone = new Set([hit.object.id, second?.id])
    return { doc: mapPage(doc, hit.pi, (page) => ({ ...page, objects: page.objects.filter((o) => !gone.has(o.id)) })), label: 'Delete' }
  },
  duplicate: (doc, s) => {
    const hit = pick(doc, s.a, s.b)
    if (!hit) return null
    const copy = reidTree(hit.object, `d${s.n}`)
    const moved: DocObject = { ...copy, left: num0(copy, 'left') + 20, top: num0(copy, 'top') + 20 }
    return { doc: mapPage(doc, hit.pi, (page) => ({ ...page, objects: [...page.objects, moved] })), label: 'Duplicate' }
  },
  group: (doc, s) => {
    const { pi, page } = pageOf(doc, s.a)
    if (page.objects.length < 2) return null
    const first = s.b % page.objects.length
    const second = (first + 1 + (s.c % (page.objects.length - 1))) % page.objects.length
    const chosen = [first, second].sort((x, y) => x - y)
    const members = chosen.map((i) => page.objects[i])
    const box = boundsOf(members)
    const group: DocObject = {
      id: `g${s.n}`,
      type: 'group',
      left: box.left + box.width / 2,
      top: box.top + box.height / 2,
      width: box.width,
      height: box.height,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      originX: 'center',
      originY: 'center',
      objects: members.map((m) => ({ ...m, left: num0(m, 'left') - box.left - box.width / 2, top: num0(m, 'top') - box.top - box.height / 2 })),
    }
    const kept = page.objects.filter((_, i) => !chosen.includes(i))
    kept.splice(Math.min(chosen[0], kept.length), 0, group)
    return { doc: mapPage(doc, pi, (p) => ({ ...p, objects: kept })), label: 'Group' }
  },
  ungroup: (doc, s) => {
    const hit = pickWhere(doc, s.a, s.b, (o) => o.type === 'group' && Array.isArray(o.objects) && o.objects.length > 0)
    if (!hit) return null
    const group = hit.object
    // Somebody may have restored one of the members at page level meanwhile (undo of a delete): ungrouping would then give
    // the page two objects with one id, and the binding would give the later one a new id (`withUniqueObjectIds`). That is
    // checked in binding.test.ts, remote.test.ts and the whole-editor fuzz; here the plain result and the shared state are
    // compared id for id, so the case is left out.
    const taken = new Set(doc.pages[hit.pi].objects.map((o) => o.id))
    if ((group.objects as DocObject[]).some((child) => taken.has(child.id))) return null
    const children = (group.objects as DocObject[]).map((child) => ({ ...child, left: num0(child, 'left') + num0(group, 'left'), top: num0(child, 'top') + num0(group, 'top') }))
    return {
      doc: mapPage(doc, hit.pi, (page) => {
        const objects = page.objects.slice()
        objects.splice(hit.oi, 1, ...children)
        return { ...page, objects }
      }),
      label: 'Ungroup',
    }
  },
  zorder: (doc, s) => {
    const hit = pick(doc, s.a, s.b)
    if (!hit) return null
    const page = doc.pages[hit.pi]
    const order = reorderIds(page.objects.map((o) => o.id), new Set([hit.object.id]), (['front', 'back', 'forward', 'backward'] as const)[s.c % 4])
    const byId = new Map(page.objects.map((o) => [o.id, o]))
    return { doc: mapPage(doc, hit.pi, (p) => ({ ...p, objects: order.map((id) => byId.get(id) as DocObject) })), label: 'Arrange' }
  },
  reorder: (doc, s) => {
    const hit = pick(doc, s.a, s.b)
    if (!hit) return null
    const page = doc.pages[hit.pi]
    const order = moveId(page.objects.map((o) => o.id), hit.object.id, s.c % page.objects.length)
    const byId = new Map(page.objects.map((o) => [o.id, o]))
    return { doc: mapPage(doc, hit.pi, (p) => ({ ...p, objects: order.map((id) => byId.get(id) as DocObject) })), label: 'Reorder layers' }
  },
  lock: onObject('Lock', undefined, (o, s) => {
    if (s.c % 2 === 0) return { ...o, locked: true, ...Object.fromEntries(LOCK_PROPS.map((k) => [k, true])), hasControls: false }
    return without(o, 'locked', 'hasControls', ...LOCK_PROPS)
  }),
  hide: onObject('Hide', undefined, (o, s) => (s.c % 2 === 0 ? { ...o, visible: false } : without(o, 'visible'))),
  rename: onObject('Rename', 'name', (o, s) => (s.c % 5 === 0 ? without(o, 'name') : { ...o, name: `Layer ${s.c}` })),
  fill: onObject('Fill', 'fill', (o, s) => {
    if (s.c % 3 === 0) return { ...o, fill: { type: 'linear', coords: { x1: 0, y1: 0, x2: 1, y2: 1 }, colorStops: [{ offset: 0, color: solid(s.d) }, { offset: 1, color: solid(s.d + 2) }] } }
    return { ...o, fill: solid(s.d) }
  }),
  stroke: onObject('Stroke', 'stroke', (o, s) => ({ ...o, stroke: solid(s.c), strokeWidth: s.d % 12, strokeDashArray: s.d % 4 === 0 ? [4, 4] : null })),
  opacity: onObject('Opacity', 'opacity', (o, s) => ({ ...o, opacity: (s.c % 101) / 100 })),
  shadow: onObject('Shadow', 'shadow', (o, s) => (s.c % 4 === 0 ? without(o, 'shadow') : { ...o, shadow: { color: '#000000', blur: s.c % 40, offsetX: s.d % 20, offsetY: (s.d >> 2) % 20 } })),
  effects: onObject('Effects', 'effects', (o, s) => {
    const current = (typeof o.effects === 'object' && o.effects !== null ? o.effects : {}) as Record<string, unknown>
    const key = (['shadow', 'outline', 'glow', 'background'] as const)[s.c % 4]
    const patch = { ...current, [key]: { color: solid(s.d), blur: s.d % 30, width: 1 + (s.d % 8) } }
    return s.d % 5 === 0 ? without(o, 'effects') : { ...o, effects: patch }
  }),
  filters: onObject(
    'Filters',
    'filters',
    (o, s) => (s.c % 4 === 0 ? without(o, 'filters') : { ...o, filters: Array.from({ length: 1 + (s.c % 3) }, (_, i) => ({ type: FILTER_TYPES[(s.d + i) % FILTER_TYPES.length], value: ((s.d + i) % 100) / 100 })) }),
    isImage,
  ),
  mask: onObject('Mask', undefined, (o, s) => (s.c % 4 === 0 ? without(o, 'maskShape', 'maskRadius') : { ...o, maskShape: MASKS[s.c % MASKS.length], ...(s.c % 3 === 0 ? { maskRadius: s.d % 40 } : {}) }), isImage),
  textEdit: onObject(
    'Edit text',
    undefined,
    (o, s) => {
      const text = Array.from({ length: 1 + (s.c % 5) }, (_, i) => WORDS[(s.d + i) % WORDS.length]).join(' ')
      const next: DocObject = { ...o, text }
      if (s.d % 3 === 0) next.styles = [{ start: 0, end: Math.min(3, text.length), style: { fill: solid(s.c), fontStyle: 'italic' } }]
      else if (s.d % 3 === 1) delete next.styles
      return next
    },
    isText,
  ),
  textStyle: onObject(
    'Format text',
    'text',
    (o, s) => {
      const key = (['fontSize', 'fontFamily', 'fontWeight', 'textAlign', 'lineHeight', 'charSpacing', 'underline', 'textCase'] as const)[s.c % 8]
      const values: Record<(typeof key), unknown> = {
        fontSize: num(s.d, 8, 120),
        fontFamily: FONTS[s.d % FONTS.length],
        fontWeight: s.d % 2 === 0 ? 700 : 'normal',
        textAlign: (['left', 'center', 'right', 'justify'] as const)[s.d % 4],
        lineHeight: 0.8 + (s.d % 20) / 10,
        charSpacing: s.d % 300,
        underline: s.d % 2 === 0,
        textCase: (['none', 'upper', 'lower', 'title'] as const)[s.d % 4],
      }
      return { ...o, [key]: values[key] }
    },
    isText,
  ),
  insertShape: (doc, s) => {
    const { pi, page } = pageOf(doc, s.a)
    const size = getPageSize(doc, page.id)
    const shape = shapeProps(new Random(s.n + 5), `n${s.n}`, size.width, size.height)
    return { doc: mapPage(doc, pi, (p) => ({ ...p, objects: [...p.objects, shape] })), label: 'Add shape' }
  },
  insertText: (doc, s) => {
    const { pi, page } = pageOf(doc, s.a)
    const size = getPageSize(doc, page.id)
    const text = textProps(new Random(s.n + 6), `n${s.n}`, size.width, size.height)
    return { doc: mapPage(doc, pi, (p) => ({ ...p, objects: [...p.objects, text] })), label: 'Add text' }
  },
  insertImage: (doc, s) => {
    const { pi, page } = pageOf(doc, s.a)
    const size = getPageSize(doc, page.id)
    const image = imageProps(new Random(s.n + 7), `n${s.n}`, size.width, size.height)
    return { doc: mapPage(doc, pi, (p) => ({ ...p, objects: [...p.objects, image] })), label: 'Add image' }
  },
  fillPlaceholder: onObject(
    'Fill placeholder',
    undefined,
    (o, s) => {
      const slot = (typeof o.slot === 'object' && o.slot !== null ? o.slot : {}) as Record<string, unknown>
      return { ...without(o, 'isPlaceholder'), src: `/media/upload-${s.c % 9}.png`, slot: { ...slot, src: `/media/upload-${s.c % 9}.png` }, scaleX: 1 + (s.d % 5) / 10 }
    },
    (o) => isImage(o) && o.isPlaceholder === true,
  ),
  animate: onObject('Animation', 'anim', (o, s) => {
    const slot = (['enter', 'exit', 'emphasis'] as const)[s.c % 3]
    const page = { objects: [o], durationSec: 5 }
    const current = o.animation as ObjectAnimation | undefined
    let next: ObjectAnimation | undefined
    if (s.d % 5 === 0) next = withoutSlot(current, slot)
    else if (s.d % 5 === 1 && current?.[slot]) next = withPatch(current, slot, { durationMs: 100 + (s.d % 40) * 100, delayMs: (s.d % 30) * 100 } as Partial<Anim>)
    else {
      const ids = presetIds(slot)
      next = withPreset(current, slot, ids[s.d % ids.length], page) ?? current
    }
    return next ? { ...o, animation: next } : without(o, 'animation')
  }),
  pageAdd: (doc, s) => {
    const at = 1 + (s.a % doc.pages.length)
    const size = newPageSize(doc, at)
    const page: DocPage = { id: `np${s.n}`, background: { type: 'solid', color: '#ffffff' }, objects: [], width: size.width, height: size.height }
    const added = addPage(doc, at, page)
    return added === doc ? null : { doc: normalizeSizes(added), label: 'Add page' }
  },
  pageDuplicate: (doc, s) => {
    const { page } = pageOf(doc, s.a)
    const next = duplicatePage(doc, page.id)
    return next === doc ? null : { doc: next, label: 'Duplicate page' }
  },
  pageRemove: (doc, s) => {
    const { page } = pageOf(doc, s.a)
    const next = removePage(doc, page.id)
    return next === doc ? null : { doc: normalizeSizes(next), label: 'Delete page' }
  },
  pageMove: (doc, s) => {
    const { page } = pageOf(doc, s.a)
    const next = movePage(doc, page.id, s.b % doc.pages.length)
    return next === doc ? null : { doc: normalizeSizes(next), label: 'Move page' }
  },
  pageRename: (doc, s) => {
    const { page } = pageOf(doc, s.a)
    const next = renamePage(doc, page.id, s.b % 4 === 0 ? '' : `Page ${s.b}`)
    return next === doc ? null : { doc: next, label: 'Rename page', key: `rename:${page.id}` }
  },
  pageBackground: (doc, s) => {
    const { page } = pageOf(doc, s.a)
    return { doc: setPageBackground(doc, page.id, backgroundOf(s.b, s.c)), label: 'Background', key: `bg:${page.id}` }
  },
  pageBackgroundAll: (doc, s) => ({ doc: applyBackgroundToAll(doc, backgroundOf(s.b, s.c)), label: 'Background for all pages' }),
  pageResize: (doc, s) => {
    const { page } = pageOf(doc, s.a)
    const [w, h] = SIZES[s.b % SIZES.length]
    const mode = (['scale', 'keep', 'magic'] as const)[s.c % 3] satisfies ResizeMode
    const resized = resizePage(doc, page.id, w, h, mode)
    if (resized === doc) return null
    const sizeChanged = !sameSize(getPageSize(resized, resized.pages[0].id), getPageSize(doc, doc.pages[0].id))
    const meta = sizeChanged && resized.meta?.presetId !== undefined ? { ...resized.meta, presetId: undefined } : resized.meta
    return { doc: meta === resized.meta ? resized : { ...resized, meta }, label: 'Resize page' }
  },
  resizeDesign: (doc, s) => {
    const [w, h] = SIZES[s.b % SIZES.length]
    const resized = resizeDocument(doc, w, h, (['scale', 'keep', 'magic'] as const)[s.c % 3])
    if (resized === doc) return null
    const sizeChanged = !sameSize(getPageSize(resized, resized.pages[0].id), getPageSize(doc, doc.pages[0].id))
    const meta = sizeChanged && resized.meta?.presetId !== undefined ? { ...resized.meta, presetId: undefined } : resized.meta
    return { doc: meta === resized.meta ? resized : { ...resized, meta }, label: 'Resize design' }
  },
  unit: (doc, s) => {
    const unit = (['px', 'mm', 'in'] as const)[s.a % 3]
    return doc.unit === unit ? null : { doc: { ...doc, unit }, label: 'Unit' }
  },
  bleed: (doc, s) => ({ doc: { ...doc, meta: { ...doc.meta, bleedPx: s.a % 60 } }, label: 'Print margin', key: 'bleed' }),
  guides: (doc, s) => {
    const { pi, page } = pageOf(doc, s.a)
    const guides = s.b % 4 === 0 ? [] : [...(page.guides ?? []), { orientation: s.b % 2 === 0 ? ('horizontal' as const) : ('vertical' as const), pos: s.c % 500 }]
    return {
      doc: mapPage(doc, pi, (p) => {
        const next = { ...p }
        if (guides.length > 0) next.guides = guides
        else delete next.guides
        return next
      }),
      label: 'Guides',
    }
  },
  notes: (doc, s) => {
    const { page } = pageOf(doc, s.a)
    const next = setPageNotes(doc, page.id, s.b % 4 === 0 ? '' : `Notes ${s.b} — ünï 🎨`)
    return next === doc ? null : { doc: next, label: 'Notes', key: `notes:${page.id}` }
  },
  duration: (doc, s) => {
    const { page } = pageOf(doc, s.a)
    const next = setPageDuration(doc, page.id, s.b % 5 === 0 ? null : 1 + (s.b % 120))
    return next === doc ? null : { doc: next, label: 'Page time', key: `duration:${page.id}` }
  },
  durationAll: (doc, s) => {
    const next = setAllDurations(doc, s.b % 4 === 0 ? null : 1 + (s.b % 60))
    return next === doc ? null : { doc: next, label: 'Time for all pages' }
  },
  transition: (doc, s) => {
    const { pi, page } = pageOf(doc, s.a)
    const ids = transitionPresets.list().map((p) => p.id)
    const transition = s.b % 4 === 0 ? null : normalizeTransition({ ...(newTransition(ids[s.c % ids.length]) ?? {}), durationMs: 200 + (s.d % 2800) })
    return {
      doc: mapPage(doc, pi, (p) => {
        const next = { ...p }
        if (transition) next.transition = transition
        else delete next.transition
        return next
      }),
      label: 'Transition',
      key: transition ? `transition:${page.id}` : undefined,
    }
  },
  template: (doc, s) => {
    const pageId = pageOf(doc, s.a).page.id
    const template = makeSeedDoc(s.b + 100, `t${s.n}-`)
    const mode = (['replace', 'replace-resize', 'add', 'add-all'] as const)[s.c % 4]
    const applied = applyTemplate(doc, pageId, template, mode)
    return applied ? { doc: applied.doc, label: 'Apply template' } : null
  },
  audioAdd: (doc, s) => {
    const tracks = (doc.audioTracks ?? []) as AudioTrack[]
    if (tracks.length >= 32) return null
    const page = doc.pages[s.a % doc.pages.length]
    const durationMs = 1000 + (s.c % 60_000)
    const track: AudioTrack = {
      id: `a${s.n}`,
      kind: (['music', 'voiceover', 'sfx', 'upload'] as const)[s.b % 4],
      name: `Track ${s.n}`,
      src: `/media/audio-${s.d % 9}.mp3`,
      scope: s.b % 3 === 0 ? { type: 'page', pageId: page.id } : { type: 'design' },
      startMs: s.d % 5000,
      durationMs,
      trimStartMs: 0,
      trimEndMs: durationMs,
      volume: (s.c % 101) / 100,
      fadeInMs: s.d % 1000,
      fadeOutMs: s.c % 1000,
      loop: s.d % 2 === 0,
      muted: false,
    }
    return { doc: { ...doc, audioTracks: [...tracks, track] }, label: 'Add audio' }
  },
  audioEdit: (doc, s) => {
    const tracks = (doc.audioTracks ?? []) as AudioTrack[]
    if (tracks.length === 0) return null
    const index = s.a % tracks.length
    const track = tracks[index]
    const next: AudioTrack = s.c % 2 === 0 ? { ...track, volume: (s.d % 101) / 100 } : { ...track, muted: track.muted !== true, startMs: s.d % 3000 }
    const list = tracks.slice()
    list[index] = next
    return { doc: { ...doc, audioTracks: list }, label: 'Edit audio', key: `audio:${track.id}` }
  },
  audioRemove: (doc, s) => {
    const tracks = (doc.audioTracks ?? []) as AudioTrack[]
    if (tracks.length === 0) return null
    const rest = tracks.filter((_, i) => i !== s.a % tracks.length)
    const next = { ...doc }
    if (rest.length > 0) next.audioTracks = rest
    else delete next.audioTracks
    return { doc: next, label: 'Remove audio' }
  },
  future: (doc, s) => {
    const name = ['x-alpha', 'x-beta', 'animation2', 'durationSec2'][s.c % 4]
    const value = futureValue(s.d)
    switch (s.b % 3) {
      case 0: {
        const hit = pick(doc, s.a, s.d)
        return hit ? { doc: mapObject(doc, hit.pi, hit.oi, (o) => ({ ...o, [name]: value })), label: 'Future object' } : null
      }
      case 1: {
        const { pi } = pageOf(doc, s.a)
        return { doc: mapPage(doc, pi, (p) => ({ ...p, [name]: value })), label: 'Future page' }
      }
      default:
        return { doc: { ...doc, [name]: value } as DoryDocument, label: 'Future document' }
    }
  },
}

/** The document after `step`, or null when the edit does not apply to this document. */
export function applyStep(doc: DoryDocument, step: Step): Edit | null {
  if (step.k !== 'op' || !step.op) return null
  const edit = catalogue[step.op](doc, step)
  return edit && edit.doc !== doc ? edit : null
}

