/**
 * Page background → Fabric. Solid and gradient backgrounds are a non-interactive rect covering the page;
 * image backgrounds are a (cover/contain/tile) image over a white base. Both go into
 * `canvas.backgroundImage`, which renders through the viewport transform so it follows zoom and the live
 * canvas window (plain `backgroundColor` would fill the whole canvas element).
 */
import { FabricImage, type FabricObject, Pattern, Rect, type StaticCanvas } from 'fabric'
import type { PageBackground } from '@/types/document'
import { type FillSpec, buildFill } from './fills'

const flat = {
  originX: 'left' as const,
  originY: 'top' as const,
  left: 0,
  top: 0,
  selectable: false,
  evented: false,
  objectCaching: false,
}

export function backgroundToFill(bg: PageBackground): FillSpec {
  if (bg.type === 'gradient') return { type: 'gradient', kind: bg.kind, angle: bg.angle ?? 90, stops: bg.stops }
  if (bg.type === 'solid') return { type: 'solid', color: bg.color }
  return { type: 'solid', color: '#ffffff' }
}

export interface BuiltBackground {
  object: FabricObject
  /** Base colour drawn behind the object (image backgrounds sit on white). */
  color: string
}

export async function buildBackground(
  bg: PageBackground,
  width: number,
  height: number,
  resolveSrc: (src: string) => Promise<string>,
): Promise<BuiltBackground> {
  if (bg.type !== 'image') {
    return { object: new Rect({ ...flat, width, height, fill: buildFill(backgroundToFill(bg)) }), color: '' }
  }
  const img = await FabricImage.fromURL(await resolveSrc(bg.src), { crossOrigin: 'anonymous' })
  const opacity = bg.opacity ?? 1
  if (bg.fit === 'tile') {
    const pattern = new Pattern({ source: img.getElement() as CanvasImageSource, repeat: 'repeat' })
    return { object: new Rect({ ...flat, width, height, fill: pattern, opacity }), color: '#ffffff' }
  }
  const iw = img.width || 1
  const ih = img.height || 1
  const base = bg.fit === 'cover' ? Math.max(width / iw, height / ih) : Math.min(width / iw, height / ih)
  const scale = base * (bg.scale ?? 1)
  img.set({
    ...flat,
    opacity,
    scaleX: scale,
    scaleY: scale,
    left: (width - iw * scale) / 2 + (bg.offsetX ?? 0),
    top: (height - ih * scale) / 2 + (bg.offsetY ?? 0),
  })
  return { object: img, color: '#ffffff' }
}

/** Installs a built background and the page-sized clip on a canvas (live or static). */
export function installBackground(canvas: StaticCanvas, built: BuiltBackground | null, width: number, height: number): void {
  canvas.backgroundColor = built?.color ?? ''
  canvas.backgroundImage = built?.object
  canvas.clipPath = new Rect({ originX: 'left', originY: 'top', left: 0, top: 0, width, height, absolutePositioned: true, excludeFromExport: true })
}
