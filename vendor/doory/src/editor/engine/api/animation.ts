/**
 * Animation commands on the objects of the active page: set a preset, change its settings, move it in time, remove
 * it, animate the whole page in one style. Like every command they act on the selection (or on the ids given), skip
 * what cannot be animated, record one undo step and do nothing in a read-only editor.
 *
 * The edit goes onto the live objects (the `animation` property is part of `EXTRA_PROPS`, so the page is written back
 * with it); no object is rebuilt and the real-time layer sees one property of each object change.
 * Page transitions are `pages.setTransition` / `pages.setTransitionAll`.
 */
import type { FabricObject } from 'fabric'
import type { Anim, ObjectAnimation } from '@/types/document'
import { type AnimSlot } from '../../animation/model'
import { readAnimation, withPatch, withPreset, withoutSlot } from '../../animation/ops'
import { pageStyleById, stylePageObjects } from '../../animation/pageStyles'
import { inOutPresets, emphasisPresets } from '../../animation/presets'
import { animationStrings as a } from '../../animation/strings'
import type { EditorEngine } from '../editor'
import { asDory } from '../objects/dory'

export class AnimationApi {
  constructor(private readonly engine: EditorEngine) {}

  /** The live objects an edit reaches: the ids given, or the selection. Objects the editor cannot rebuild are left out. */
  private targets(ids?: readonly string[]): FabricObject[] {
    const view = this.engine.activeView()
    if (!view || this.engine.readOnly) return []
    const objects = ids ? ids.map((id) => view.getById(id)) : view.selectedObjects()
    return objects.filter((o): o is FabricObject => !!o && !asDory(o).rawDoc && !asDory(o).isUi)
  }

  private page() {
    return this.engine.getPage(this.engine.state.activePageId)
  }

  /** Applies `change` to the animation of each object; one undo step when anything changed. Returns how many objects changed. */
  private update(
    objects: readonly FabricObject[],
    change: (current: ObjectAnimation | undefined, object: FabricObject) => ObjectAnimation | undefined | null,
    label: string,
    coalesceKey?: string,
  ): number {
    let changed = 0
    for (const object of objects) {
      const current = readAnimation(asDory(object).animation)
      const next = change(current, object)
      if (next === null || next === current) continue
      if (JSON.stringify(next ?? null) === JSON.stringify(current ?? null)) continue
      asDory(object).animation = next
      object.set('dirty', true)
      changed++
    }
    if (changed > 0) this.engine.commitActive({ label, coalesceKey })
    return changed
  }

  /** The animation of an object on the active page as the editor understands it. */
  get(id: string): ObjectAnimation | undefined {
    return readAnimation(this.page()?.objects.find((o) => o.id === id)?.animation)
  }

  /** Puts a preset into `slot` of the selected objects (or of `ids`), keeping delay, strength and text unit when they still fit. */
  setPreset(slot: AnimSlot, presetId: string, ids?: readonly string[]): void {
    const page = this.page()
    const preset = slot === 'emphasis' ? emphasisPresets.get(presetId) : inOutPresets.get(presetId)
    if (!page || !preset) return
    const targets = this.targets(ids)
    const had = targets.some((o) => readAnimation(asDory(o).animation)?.[slot] !== undefined)
    const label = had ? a.history.change : slot === 'enter' ? a.history.addEnter : slot === 'exit' ? a.history.addExit : a.history.addEmphasis
    const changed = this.update(targets, (current) => withPreset(current, slot, presetId, page), label)
    if (changed > 0) this.engine.announce(a.announce.added(preset.label))
  }

  /**
   * Changes settings of `slot`. `coalesceKey` joins the steps of one slider drag or one bar drag into a single undo
   * step; a value of `undefined` removes that setting.
   */
  patch(slot: AnimSlot, patch: Partial<Anim>, ids?: readonly string[], coalesceKey?: string): void {
    this.update(this.targets(ids), (current) => withPatch(current, slot, patch), a.history.timing, coalesceKey ?? `anim:${slot}`)
  }

  remove(slot: AnimSlot, ids?: readonly string[]): void {
    if (this.update(this.targets(ids), (current) => withoutSlot(current, slot), a.history.remove) > 0) this.engine.announce(a.announce.removed)
  }

  /** Removes every animation of the selected objects (or of `ids`). */
  removeAll(ids?: readonly string[]): void {
    if (this.update(this.targets(ids), (current) => (current ? undefined : current), a.history.remove) > 0) this.engine.announce(a.announce.removed)
  }

  /**
   * Animates the active page in one style: every object that can be animated gets the style's enter animation, one
   * after another in reading order. Exit and emphasis animations stay.
   */
  applyPageStyle(styleId: string): void {
    const page = this.page()
    const style = pageStyleById(styleId)
    const view = this.engine.activeView()
    if (!page || !style || !view || this.engine.readOnly) return
    const anims = stylePageObjects(page.objects, style)
    const objects = view.canvas.getObjects().filter((o) => !asDory(o).rawDoc && anims.has(asDory(o).id ?? ''))
    const changed = this.update(objects, (current, object) => ({ ...current, enter: anims.get(asDory(object).id ?? '') }), a.history.pageStyle)
    if (changed > 0) this.engine.announce(a.announce.pageStyled(changed))
  }

  /** Removes the animation of every object on the active page. */
  clearPage(): void {
    const view = this.engine.activeView()
    if (!view) return
    const objects = view.canvas.getObjects().filter((o) => !asDory(o).rawDoc && !asDory(o).isUi && asDory(o).animation !== undefined)
    if (this.update(objects, (current) => (current ? undefined : current), a.history.clearPage) > 0) this.engine.announce(a.announce.pageCleared)
  }
}

