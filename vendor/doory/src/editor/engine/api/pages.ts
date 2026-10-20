import type { DocPage, DocUnit, PageBackground, PageGuide, PageTransition } from '@/types/document'
import {
  addPage,
  applyBackgroundToAll,
  clampSize,
  createPage,
  duplicatePage,
  findPageIndex,
  movePage,
  removePage,
  renamePage,
  setPageBackground,
} from '../docOps'
import type { EditorEngine } from '../editor'
import { isFiniteNumber } from '../numbers'
import { asDory } from '../objects/dory'
import { mirrorSlot } from '../objects/slot'
import { objectRect } from '../pageCanvas'
import { type ResizeMode, resizeDocument, resizePage } from '../magicResize'
import { type PageSize, getPageSize, newPageSize, normalizeSizes, sameSize } from '../pageSizes'
import { normalizeTransition } from '../../animation/model'
import { setAllPageTransitions, setPageTransition } from '../../animation/ops'
import { transitionPresets } from '../../animation/presets'
import { animationStrings as anim } from '../../animation/strings'
import { setAllDurations, setPageDuration, setPageNotes } from '../../presenter/pageProps'
import { t } from '../../strings'

/** Which pages a resize reaches: the one page (`page`) or every page of the design (`all`). */
export type ResizeScope = 'page' | 'all'

export interface ResizeOptions {
  /** Default `all`, the original meaning of `resize(width, height, mode)`. */
  scope?: ResizeScope
  /** The page `scope: 'page'` acts on; default the active page. */
  pageId?: string
}

export class PagesApi {
  constructor(private readonly engine: EditorEngine) {}

  private get doc() {
    return this.engine.state.doc
  }

  /**
   * Adds a blank page at `index` (default: after the active page) and makes it active. The page has `size` when given
   * (a flyer between two posters), otherwise the size of the page before it.
   */
  add(index?: number, size?: PageSize): string | null {
    const doc = this.doc
    const at = Math.max(0, Math.min(doc.pages.length, index ?? findPageIndex(doc, this.engine.state.activePageId) + 1))
    const wanted = size && isFiniteNumber(size.width) && isFiniteNumber(size.height) ? size : newPageSize(doc, at)
    const page: DocPage = { ...createPage(), width: clampSize(wanted.width), height: clampSize(wanted.height) }
    const added = addPage(doc, at, page)
    if (added === doc) {
      this.engine.toast(t.errors.pageLimit, 'error')
      return null
    }
    const next = normalizeSizes(added)
    this.engine.applyDocument(next, { label: t.history.addPage, activePageId: page.id })
    this.engine.announce(t.announce.pageAdded(findPageIndex(next, page.id) + 1))
    this.engine.view.scrollToPage(page.id)
    if (size && !sameSize(wanted, newPageSize(doc, at))) this.engine.view.refit()
    return page.id
  }

  duplicate(pageId: string): void {
    const doc = this.doc
    const index = findPageIndex(doc, pageId)
    const next = duplicatePage(doc, pageId)
    if (next === doc) return
    const copy = next.pages[index + 1]
    this.engine.applyDocument(next, { label: t.history.duplicatePage, activePageId: copy.id })
    this.engine.announce(t.announce.pageAdded(index + 2))
    this.engine.view.scrollToPage(copy.id)
  }

  remove(pageId: string): void {
    const doc = this.doc
    const index = findPageIndex(doc, pageId)
    const removed = removePage(doc, pageId)
    if (removed === doc) return
    const next = normalizeSizes(removed)
    const neighbour = next.pages[Math.min(index, next.pages.length - 1)]
    this.engine.applyDocument(next, { label: t.history.deletePage, activePageId: neighbour.id })
    this.engine.announce(t.announce.pageDeleted)
  }

  move(pageId: string, toIndex: number): void {
    const moved = movePage(this.doc, pageId, toIndex)
    if (moved === this.doc) return
    const next = normalizeSizes(moved)
    this.engine.applyDocument(next, { label: t.history.movePage, activePageId: pageId })
    this.engine.announce(t.announce.pageMoved(findPageIndex(next, pageId) + 1))
  }

  moveBy(pageId: string, delta: number): void {
    this.move(pageId, findPageIndex(this.doc, pageId) + delta)
  }

  rename(pageId: string, name: string): void {
    const next = renamePage(this.doc, pageId, name)
    if (next !== this.doc) this.engine.applyDocument(next, { label: t.history.renamePage, coalesceKey: `rename:${pageId}` })
  }

  setBackground(pageId: string, background: PageBackground, coalesceKey?: string): void {
    const next = setPageBackground(this.doc, pageId, background)
    if (next !== this.doc) this.engine.applyDocument(next, { label: t.history.changeBackground, coalesceKey: coalesceKey ?? `bg:${pageId}` })
  }

  setBackgroundAll(background: PageBackground): void {
    this.engine.applyDocument(applyBackgroundToAll(this.doc, background), { label: t.history.applyBackgroundToAllPages })
  }

  /**
   * Gives the design a new size, remapping the content per `mode`. By default every page takes the size (what the
   * canvas-size popover always did); `{ scope: 'page' }` resizes only one page and leaves the others as they are.
   */
  resize(width: number, height: number, mode: ResizeMode, options: ResizeOptions = {}): void {
    if (!isFiniteNumber(width) || !isFiniteNumber(height) || this.engine.readOnly) return
    const doc = this.doc
    const scope = options.scope ?? 'all'
    const pageId = options.pageId ?? this.engine.state.activePageId
    if (scope === 'page' && !doc.pages.some((p) => p.id === pageId)) return
    const resized = scope === 'all' ? resizeDocument(doc, width, height, mode) : resizePage(doc, pageId, width, height, mode)
    if (resized === doc) return
    const sizeChanged = !sameSize(getPageSize(resized, resized.pages[0].id), getPageSize(doc, doc.pages[0].id))
    const meta = sizeChanged && resized.meta?.presetId !== undefined ? { ...resized.meta, presetId: undefined } : resized.meta
    const next = meta === resized.meta ? resized : { ...resized, meta }
    const target = scope === 'all' ? this.engine.state.activePageId : pageId
    this.engine.applyDocument(next, { label: scope === 'all' ? t.history.resizeDesign : t.history.resizePage, activePageId: target })
    const size = this.engine.pageSizeOf(target)
    this.engine.announce(t.announce.resized(size.width, size.height))
    // The zoom is refitted whenever the canvas size changes, whatever zoom the user had chosen.
    this.engine.view.fit(this.engine.state.zoomMode === 'fit-width' ? 'fit-width' : 'fit-page')
    if (scope === 'page') this.engine.view.scrollToPage(target)
  }

  /** Resizes one page (this page only), remapping its content per `mode`. */
  setSize(pageId: string, width: number, height: number, mode: ResizeMode): void {
    this.resize(width, height, mode, { scope: 'page', pageId })
  }

  /**
   * Mirrors the whole active page around its centre: every object swaps sides and has its own flip toggled,
   * so the page looks exactly like its mirror image. Locked objects are mirrored too.
   */
  flipCanvas(axis: 'horizontal' | 'vertical'): void {
    const view = this.engine.activeView()
    if (!view || this.engine.readOnly) return
    const size = this.engine.pageSizeOf(this.engine.state.activePageId)
    view.canvas.discardActiveObject()
    for (const o of view.canvas.getObjects()) {
      if (asDory(o).isUi) continue
      const r = objectRect(o)
      if (axis === 'horizontal') o.set({ left: o.left + (size.width - r.left - r.width - r.left), flipX: !o.flipX })
      else o.set({ top: o.top + (size.height - r.top - r.height - r.top), flipY: !o.flipY })
      o.setCoords()
      // A photo's frame is mirrored with the page, tilt included.
      mirrorSlot(o, axis, (axis === 'horizontal' ? size.width : size.height) / 2)
    }
    view.canvas.requestRenderAll()
    this.engine.commitActive({ label: axis === 'horizontal' ? t.history.flipCanvasHorizontal : t.history.flipCanvasVertical })
  }

  setUnit(unit: DocUnit): void {
    const doc = this.doc
    if (doc.unit === unit) return
    this.engine.applyDocument({ ...doc, unit }, { label: t.history.changeUnit })
  }

  setBleed(bleedPx: number): void {
    if (!isFiniteNumber(bleedPx)) return
    const doc = this.doc
    this.engine.applyDocument({ ...doc, meta: { ...doc.meta, bleedPx: Math.max(0, Math.round(bleedPx)) } }, { label: t.history.changePrintMargin, coalesceKey: 'bleed' })
  }

  setGuides(pageId: string, guides: PageGuide[]): void {
    const doc = this.doc
    const index = findPageIndex(doc, pageId)
    if (index < 0) return
    const page = { ...doc.pages[index] }
    if (guides.length > 0) page.guides = guides
    else delete page.guides
    this.engine.applyDocument({ ...doc, pages: doc.pages.map((p, i) => (i === index ? page : p)) }, { label: t.history.changeGuides })
  }

  addGuide(pageId: string, guide: PageGuide): void {
    const page = this.doc.pages.find((p) => p.id === pageId)
    if (page) this.setGuides(pageId, [...(page.guides ?? []), guide])
  }

  /**
   * Sets the speaker notes of a page (plain text, at most 5000 characters; longer text is cut, empty text removes the
   * notes). Typing bursts coalesce into one undo step. Read-only editors ignore the call.
   */
  setNotes(pageId: string, text: string): void {
    if (this.engine.readOnly) return
    const next = setPageNotes(this.doc, pageId, text)
    if (next !== this.doc) this.engine.applyDocument(next, { label: t.history.editNotes, coalesceKey: `notes:${pageId}` })
  }

  /**
   * Sets how long a page stays up when a presentation advances by itself (1-600 s, rounded; `null` removes the time,
   * and the page then waits for the presenter). Repeated calls on one page coalesce into one undo step.
   */
  setDuration(pageId: string, sec: number | null): void {
    if (this.engine.readOnly) return
    const next = setPageDuration(this.doc, pageId, sec)
    if (next !== this.doc) this.engine.applyDocument(next, { label: t.history.setPageTime, coalesceKey: `duration:${pageId}` })
  }

  /** Gives every page the same time (`null` clears all of them): the design-wide default. One undo step. */
  setDurationAll(sec: number | null): void {
    if (this.engine.readOnly) return
    const next = setAllDurations(this.doc, sec)
    if (next !== this.doc) this.engine.applyDocument(next, { label: t.history.setAllPageTimes })
  }

  /**
   * Sets how a page comes in when a presentation or a video reaches it (`null` removes the transition). The duration
   * is limited to 200..3000 ms. Repeated calls on one page (a duration slider) coalesce into one undo step.
   */
  setTransition(pageId: string, transition: PageTransition | null): void {
    const clean = transition === null ? null : normalizeTransition(transition)
    if (this.engine.readOnly || (transition !== null && clean === null)) return
    const next = setPageTransition(this.doc, pageId, clean)
    if (next === this.doc) return
    const before = this.doc.pages.find((p) => p.id === pageId)?.transition
    this.engine.applyDocument(next, { label: clean ? anim.history.transition : anim.history.removeTransition, coalesceKey: clean ? `transition:${pageId}` : undefined })
    // Said once for a change of preset (a duration slider does not talk), and when it goes.
    if (!clean) this.engine.announce(anim.announce.transitionRemoved)
    else if (before?.preset !== clean.preset) this.engine.announce(anim.announce.transitionSet(transitionPresets.get(clean.preset)?.label ?? clean.preset))
  }

  /** Gives every page the same transition (`null` clears them all). One undo step. */
  setTransitionAll(transition: PageTransition | null): void {
    const clean = transition === null ? null : normalizeTransition(transition)
    if (this.engine.readOnly || (transition !== null && clean === null)) return
    const next = setAllPageTransitions(this.doc, clean)
    if (next === this.doc) return
    this.engine.applyDocument(next, { label: clean ? anim.history.transitionAll : anim.history.removeTransitionAll })
  }

  activate(pageId: string, scroll = true): void {
    this.engine.setActivePage(pageId)
    if (scroll) this.engine.view.scrollToPage(pageId)
  }
}
