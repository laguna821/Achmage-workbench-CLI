import type { FabricImage } from 'fabric'
import { CropSession } from '../crop'
import type { EditorEngine } from '../editor'
import { asDory } from '../objects/dory'
import { hasSlot } from '../objects/slot'
import { t } from '../../strings'

/** Crop mode controller (one session at a time). */
export class CropApi {
  private session: CropSession | null = null

  constructor(private readonly engine: EditorEngine) {}

  get active(): boolean {
    return this.session !== null
  }

  async start(): Promise<void> {
    if (this.session || this.engine.readOnly) return
    const view = this.engine.activeView()
    const obj = view?.selectedObjects()[0]
    // A photo in a placeholder frame is positioned by dragging it inside the frame, not by cropping.
    if (!view || !obj || obj.type !== 'image' || asDory(obj).locked || hasSlot(obj)) return
    const id = asDory(obj).id ?? ''
    this.engine.patchUi({ cropping: { pageId: this.engine.state.activePageId, id } })
    this.session = await CropSession.start(view, obj as FabricImage, this.engine.theme, () => {
      this.session = null
      this.engine.patchUi({ cropping: null })
    })
  }

  apply(): void {
    const view = this.engine.activeView()
    const changed = this.session?.apply()
    if (changed && view) this.engine.commitActive({ label: t.history.crop })
    else this.engine.refreshSelection()
  }

  cancel(): void {
    this.session?.cancel()
    this.engine.refreshSelection()
  }

  setAspect(ratio: number | null): void {
    this.session?.setAspect(ratio)
  }

  reset(): void {
    this.session?.reset()
  }
}
