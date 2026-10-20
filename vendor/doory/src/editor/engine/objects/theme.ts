/**
 * Canvas selection styling driven by the design tokens. Colours are read from CSS custom properties at
 * runtime so light/dark themes (and any future theme) are followed without hard-coded values.
 */
import { type Canvas, FabricObject } from 'fabric'

export interface CanvasTheme {
  selection: string
  guide: string
  surface: string
  muted: string
  text: string
  workspace: string
}

const FALLBACK: CanvasTheme = {
  selection: '#6a52d9',
  guide: '#ec5f98',
  surface: '#ffffff',
  muted: '#73667a',
  text: '#2b1c17',
  workspace: '#ebe7f5',
}

export function readCanvasTheme(el: Element = document.documentElement): CanvasTheme {
  if (typeof getComputedStyle !== 'function') return FALLBACK
  const cs = getComputedStyle(el)
  const get = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    selection: get('--selection-color', FALLBACK.selection),
    guide: get('--guide-color', FALLBACK.guide),
    surface: get('--color-surface', FALLBACK.surface),
    muted: get('--color-text-subtle', FALLBACK.muted),
    text: get('--color-text', FALLBACK.text),
    workspace: get('--color-canvas-workspace', FALLBACK.workspace),
  }
}

/** Selection style props applied to every object (so handles follow the theme). */
export function selectionStyle(theme: CanvasTheme): Partial<FabricObject> {
  return {
    borderColor: theme.selection,
    cornerColor: '#ffffff',
    cornerStrokeColor: theme.selection,
    cornerStyle: 'circle',
    transparentCorners: false,
    cornerSize: 11,
    touchCornerSize: 30,
    borderScaleFactor: 1.5,
    borderOpacityWhenMoving: 0.5,
    // The selection border sits 2 px outside the object (text gets more, see PageCanvas).
    padding: 2,
    lockSkewingX: true,
    lockSkewingY: true,
    snapAngle: 15,
    snapThreshold: 4,
  }
}

/** Updates the defaults for objects created from now on. */
export function applyThemeDefaults(theme: CanvasTheme): void {
  Object.assign(FabricObject.ownDefaults, selectionStyle(theme))
}

/** Re-styles the objects already on a canvas, plus the marquee. */
export function applyThemeToCanvas(canvas: Canvas, theme: CanvasTheme): void {
  canvas.selectionColor = withAlpha(theme.selection, 0.1)
  canvas.selectionBorderColor = theme.selection
  canvas.selectionLineWidth = 1
  const style = selectionStyle(theme)
  for (const o of canvas.getObjects()) o.set(style)
  const active = canvas.getActiveObject()
  if (active) active.set(style)
  canvas.requestRenderAll()
}

function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return color
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
