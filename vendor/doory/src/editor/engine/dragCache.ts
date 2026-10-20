/**
 * Drag layer cache. Fabric repaints every object on every pointer move, which is fine for a few dozen
 * objects and slow for a few hundred, especially on machines that rasterise on the CPU. While the user
 * drags, scales or rotates a selection nothing else on the page changes, so the objects below the
 * selection and the objects above it are painted once into two bitmaps. Until the pointer is released the
 * canvas draws just `below bitmap, selection, above bitmap`: two image draws plus the selection instead of
 * one draw per object.
 *
 * The cache only swaps the list Fabric paints (`_objectsToRender`); the canvas objects, hit testing,
 * selection and serialisation are untouched, and any structural change (an object added or removed)
 * makes Fabric drop the list, which falls back to normal painting. Output is the same pixels as the
 * uncached path (see dragCache.test.ts).
 */
import { type Canvas, FabricObject } from 'fabric'

/** Below this many objects a full repaint is cheap enough that the cache would only add latency. */
export const DRAG_CACHE_MIN_OBJECTS = 40

/** A pre-rendered layer, painted 1:1 onto the lower canvas. */
class LayerBitmap extends FabricObject {
  static override type = 'DoryLayerBitmap'

  constructor(
    private readonly bitmap: HTMLCanvasElement,
    left: number,
    top: number,
    scaleX: number,
    scaleY: number,
  ) {
    super()
    this.setOptions({
      left,
      top,
      scaleX,
      scaleY,
      width: bitmap.width,
      height: bitmap.height,
      originX: 'left',
      originY: 'top',
      objectCaching: false,
      selectable: false,
      evented: false,
      strokeWidth: 0,
      fill: '',
    })
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    ctx.drawImage(this.bitmap, -this.width / 2, -this.height / 2, this.width, this.height)
  }

  release(): void {
    this.bitmap.width = 0
    this.bitmap.height = 0
  }
}

export class DragLayerCache {
  private list: FabricObject[] | null = null
  private layers: LayerBitmap[] = []

  constructor(private readonly canvas: Canvas) {}

  /** True while the canvas is painting from the cache. */
  get active(): boolean {
    return this.list !== null && this.canvas._objectsToRender === this.list
  }

  /**
   * Starts (or restarts, when Fabric dropped the list) cached painting for the current selection.
   * A selection that is not one contiguous run in the stacking order cannot be split into "below" and
   * "above", so it keeps the normal path.
   */
  ensure(): void {
    if (this.active) return
    this.discard()
    const canvas = this.canvas
    const objects = canvas.getObjects()
    if (objects.length < DRAG_CACHE_MIN_OBJECTS) return
    const selected = canvas.getActiveObjects()
    if (selected.length === 0) return
    const indexes = selected.map((o) => objects.indexOf(o))
    if (indexes.some((i) => i < 0)) return
    const lo = Math.min(...indexes)
    const hi = Math.max(...indexes)
    if (hi - lo + 1 !== selected.length) return

    const below = this.layer(objects.slice(0, lo))
    const above = this.layer(objects.slice(hi + 1))
    const list: FabricObject[] = [...(below ? [below] : []), ...objects.slice(lo, hi + 1), ...(above ? [above] : [])]
    this.layers = [below, above].filter((l): l is LayerBitmap => l !== null)
    this.list = list
    canvas._objectsToRender = list
  }

  /** Returns to normal painting and frees the bitmaps. */
  end(): void {
    const wasActive = this.active
    this.discard()
    if (wasActive) this.canvas.requestRenderAll()
  }

  private discard(): void {
    if (this.list !== null && this.canvas._objectsToRender === this.list) this.canvas._objectsToRender = undefined
    this.list = null
    for (const layer of this.layers) layer.release()
    this.layers = []
  }

  private layer(objects: readonly FabricObject[]): LayerBitmap | null {
    if (objects.length === 0) return null
    const canvas = this.canvas
    const source = canvas.lowerCanvasEl
    const scale = canvas.getRetinaScaling()
    const vpt = canvas.viewportTransform
    const bitmap = document.createElement('canvas')
    bitmap.width = source.width
    bitmap.height = source.height
    const ctx = bitmap.getContext('2d')
    if (!ctx) return null
    ctx.scale(scale, scale)
    ctx.imageSmoothingEnabled = canvas.imageSmoothingEnabled
    ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5])
    for (const object of objects) object.render(ctx)
    // The bitmap covers exactly the canvas window, so it is placed where the window's corner is in scene space.
    return new LayerBitmap(bitmap, -vpt[4] / vpt[0], -vpt[5] / vpt[3], 1 / (vpt[0] * scale), 1 / (vpt[3] * scale))
  }
}
