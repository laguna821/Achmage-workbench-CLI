/**
 * Demo and stress documents for the dev harness and e2e specs (never shipped in the production bundle).
 */
import { StaticCanvas } from 'fabric'
import { newId } from '@/lib/document'
import type { Anim, DocObject, DocPage, DoryDocument } from '@/types/document'
import {
  createEllipse,
  createLine,
  createPathShape,
  createPolygon,
  createRect,
  createStar,
  createTextbox,
} from '../engine/objects/factories'
import { applyEffects } from '../engine/objects/effects'
import { buildFill } from '../engine/objects/fills'
import { serializeObjects } from '../engine/serialization'

function build(make: (c: StaticCanvas) => void): DocObject[] {
  const c = new StaticCanvas(document.createElement('canvas'), { width: 1080, height: 1080, renderOnAddRemove: false })
  make(c)
  const out = serializeObjects(c)
  c.dispose()
  return out
}

/** A poster-like first page plus a second, plainer page: good for screenshots. */
export function createDemoDocument(): DoryDocument {
  const size = { width: 1080, height: 1080 }
  const first = build((c) => {
    const card = createRect({ x: 540, y: 560 }, 820, 60)
    card.set({ width: 820, height: 620, fill: '#ffffff' })
    applyEffects(card, { shadow: { color: '#1c151733', blur: 40, offsetX: 0, offsetY: 18 } })
    const disc = createEllipse({ x: 880, y: 250 }, 260)
    disc.set({ fill: buildFill({ type: 'gradient', kind: 'linear', angle: 45, stops: [{ offset: 0, color: '#fb6485' }, { offset: 1, color: '#e11d48' }] }) })
    const ring = createPathShape('ring', { x: 190, y: 880 }, 220)
    ring?.set({ fill: '#ffc8d2' })
    const star = createStar({ x: 905, y: 860 }, 120, 5, 0.45)
    star.set({ fill: '#1c1517' })
    const heading = createTextbox(size, { x: 540, y: 440 }, { text: 'Design anything,\nbeautifully.', preset: 'heading', fontSize: 68, width: 700, fill: '#1c1517', textAlign: 'center', fontFamily: '"DejaVu Serif", serif' })
    const sub = createTextbox(size, { x: 540, y: 620 }, { text: 'Free, open-source, and yours.', preset: 'subheading', fontSize: 34, width: 640, fill: '#e11d48', fontFamily: '"DejaVu Sans", sans-serif' })
    sub.set({ fontWeight: 700 })
    const body = createTextbox(size, { x: 540, y: 715 }, { text: 'Drag, drop and refine text, shapes, images and more.', preset: 'body', fontSize: 24, width: 520, fill: '#6b6165', fontFamily: '"DejaVu Sans", sans-serif' })
    const rule = createLine({ x: 540, y: 548 }, { length: 180, width: 6, color: '#e11d48' })
    const hex = createPolygon({ x: 190, y: 250 }, 150, 6)
    hex.set({ fill: '#e11d48', opacity: 0.9 })
    c.add(card, disc, ring as NonNullable<typeof ring>, hex, star, heading, rule, sub, body)
  })
  const second = build((c) => {
    const t = createTextbox(size, { x: 540, y: 500 }, { text: 'Page two', preset: 'heading', width: 600, fill: '#ffffff', fontFamily: '"DejaVu Sans", sans-serif' })
    c.add(t)
  })
  const pages: DocPage[] = [
    { id: newId(), name: 'Cover', background: { type: 'gradient', kind: 'linear', angle: 135, stops: [{ offset: 0, color: '#ffe1e6' }, { offset: 1, color: '#fff1f3' }] }, objects: first },
    { id: newId(), background: { type: 'solid', color: '#e11d48' }, objects: second },
  ]
  return { schemaVersion: 1, width: size.width, height: size.height, unit: 'px', pages }
}

/**
 * A three-page deck for the presenter's specs: a landscape slide, a square page and a portrait page (every page keeps
 * its own size), with speaker notes on the first two. No page has a time; the specs set them through the UI.
 */
export function createDeckDemo(): DoryDocument {
  const sizes = [
    { name: 'Intro', width: 1920, height: 1080, color: '#ffe1e6', notes: 'Welcome everyone.\nSay who you are and why this matters.' },
    { name: 'Square', width: 1080, height: 1080, color: '#e11d48', notes: 'Walk through the square layout.' },
    { name: 'Story', width: 1080, height: 1920, color: '#1c1517', notes: '' },
  ]
  const pages: DocPage[] = sizes.map((spec, index) => {
    const objects = build((c) => {
      c.add(createTextbox({ width: spec.width, height: spec.height }, { x: spec.width / 2, y: spec.height / 2 }, { text: `${spec.name} page`, preset: 'heading', fontSize: 96, width: spec.width * 0.7, fill: index === 0 ? '#1c1517' : '#ffffff', textAlign: 'center', fontFamily: '"DejaVu Sans", sans-serif' }))
    })
    const page: DocPage = { id: newId(), name: spec.name, width: spec.width, height: spec.height, background: { type: 'solid', color: spec.color }, objects }
    if (spec.notes) page.notes = spec.notes
    return page
  })
  return { schemaVersion: 1, width: 1920, height: 1080, unit: 'px', pages }
}

const anim = (preset: string, over: Partial<Anim> = {}): Anim => ({ preset, durationMs: 700, delayMs: 0, easing: 'ease-out', ...over })

/**
 * Three landscape pages with animations and transitions for the animation specs and screenshots: a cover whose heading
 * rises word by word, a page of three cards that slide in one after another and leave again, and a closing page. Pages
 * have times (6, 5 and 4 s) and the second and third a transition.
 */
export function createAnimatedDemo(): DoryDocument {
  const size = { width: 1280, height: 720 }
  const text = (c: StaticCanvas, label: string, x: number, y: number, fontSize: number, fill: string, width = 900) => {
    const box = createTextbox(size, { x, y }, { text: label, preset: 'heading', fontSize, width, fill, textAlign: 'center', fontFamily: '"DejaVu Sans", sans-serif' })
    c.add(box)
    return box
  }
  const cover = build((c) => {
    const disc = createEllipse({ x: 1030, y: 190 }, 220)
    disc.set({ fill: '#e11d48' })
    const star = createStar({ x: 250, y: 560 }, 120, 5, 0.45)
    star.set({ fill: '#1c1517' })
    text(c, 'Animate anything', 640, 300, 84, '#1c1517', 1000)
    text(c, 'Doory brings your pages to life.', 640, 450, 36, '#6b6165', 900)
    c.add(disc, star)
  })
  const cards = build((c) => {
    text(c, 'Three ideas', 640, 140, 64, '#ffffff', 900)
    for (const [i, color] of ['#fb6485', '#ffffff', '#1c1517'].entries()) {
      const card = createRect({ x: 260 + i * 380, y: 460 }, 300, 60)
      card.set({ width: 300, height: 320, fill: color })
      c.add(card)
    }
  })
  const closing = build((c) => {
    text(c, 'Thank you', 640, 330, 110, '#e11d48', 1000)
    text(c, 'Questions?', 640, 480, 40, '#1c1517', 700)
  })
  const withAnimation = (objects: DocObject[], animations: (Record<string, unknown> | undefined)[]): DocObject[] => objects.map((o, i) => (animations[i] ? { ...o, animation: animations[i] } : o))
  const pages: DocPage[] = [
    {
      id: newId(),
      name: 'Cover',
      durationSec: 6,
      background: { type: 'solid', color: '#ffe1e6' },
      objects: withAnimation(cover, [
        { enter: anim('rise', { by: 'word', durationMs: 900 }) },
        { enter: anim('fade', { delayMs: 900 }) },
        { enter: anim('pop', { easing: 'spring', durationMs: 600 }), emphasis: anim('float', { delayMs: 800, durationMs: 2400, easing: 'linear', loop: true }) },
        { enter: anim('spin', { delayMs: 300, durationMs: 900 }) },
      ]),
    },
    {
      id: newId(),
      name: 'Cards',
      durationSec: 5,
      transition: { preset: 'push', durationMs: 700, easing: 'ease-in-out', direction: 'right' },
      background: { type: 'solid', color: '#e11d48' },
      objects: withAnimation(cards, [
        { enter: anim('typewriter', { durationMs: 1000, easing: 'linear' }) },
        { enter: anim('slide', { direction: 'left', delayMs: 500 }), exit: anim('fade', { delayMs: 4400, durationMs: 500, easing: 'ease-in' }) },
        { enter: anim('slide', { direction: 'down', delayMs: 800 }), exit: anim('fade', { delayMs: 4400, durationMs: 500, easing: 'ease-in' }) },
        { enter: anim('slide', { direction: 'right', delayMs: 1100 }), exit: anim('fade', { delayMs: 4400, durationMs: 500, easing: 'ease-in' }) },
      ]),
    },
    {
      id: newId(),
      name: 'Thanks',
      durationSec: 4,
      transition: { preset: 'circle', durationMs: 900, easing: 'ease-in-out' },
      background: { type: 'solid', color: '#ffffff' },
      objects: withAnimation(closing, [{ enter: anim('zoom', { direction: 'out', durationMs: 900 }) }, { enter: anim('fade', { delayMs: 800 }) }]),
    },
  ]
  return { schemaVersion: 1, width: size.width, height: size.height, unit: 'px', pages }
}

export function createBlankDemo(width = 1080, height = 1080): DoryDocument {
  return { schemaVersion: 1, width, height, unit: 'px', pages: [{ id: newId(), background: { type: 'solid', color: '#ffffff' }, objects: [] }] }
}

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PALETTE = ['#e11d48', '#fb6485', '#be123c', '#1c1517', '#6b6165', '#ffc8d2', '#f59e0b', '#2563eb']

/** `pages` pages with `objects` simple objects each (rects, ellipses, text) for performance checks. */
export function createStressDocument(pages: number, objects: number, size = 1080): DoryDocument {
  const rand = rng(42)
  const make = (): DocPage => {
    const list: DocObject[] = []
    for (let i = 0; i < objects; i++) {
      const color = PALETTE[Math.floor(rand() * PALETTE.length)]
      const x = rand() * (size - 120)
      const y = rand() * (size - 120)
      const w = 40 + rand() * 160
      const h = 40 + rand() * 160
      const kind = i % 3
      if (kind === 0) list.push({ id: newId(), type: 'rect', left: x, top: y, width: w, height: h, fill: color, originX: 'left', originY: 'top' })
      else if (kind === 1) list.push({ id: newId(), type: 'ellipse', left: x, top: y, rx: w / 2, ry: h / 2, width: w, height: h, fill: color, originX: 'left', originY: 'top' })
      else list.push({ id: newId(), type: 'textbox', left: x, top: y, width: 160, fontSize: 18, fontFamily: '"DejaVu Sans", sans-serif', fill: color, text: `Item ${i}`, originX: 'left', originY: 'top' })
    }
    return { id: newId(), background: { type: 'solid', color: '#ffffff' }, objects: list }
  }
  return { schemaVersion: 1, width: size, height: size, unit: 'px', pages: Array.from({ length: pages }, make) }
}
