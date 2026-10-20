export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8
export const ZOOM_STEPS: readonly number[] = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]

export type ZoomMode = 'fit-width' | 'fit-page' | 'custom'

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

export interface Size {
  width: number
  height: number
}

/**
 * Zoom that makes the page fit the viewport. `padding` is the empty space kept around the page (px,
 * per side); the result is clamped to the editor's zoom range and never above 1 for `fit-page`
 * (small designs are not blown up).
 */
export function fitZoom(viewport: Size, page: Size, mode: 'fit-width' | 'fit-page', padding = 48): number {
  const availW = Math.max(1, viewport.width - padding * 2)
  const availH = Math.max(1, viewport.height - padding * 2)
  const byWidth = availW / Math.max(1, page.width)
  const byHeight = availH / Math.max(1, page.height)
  // Fitting the page never enlarges it past 100 % (a small design is not blown up).
  const z = mode === 'fit-width' ? byWidth : Math.min(byWidth, byHeight, 1)
  return clampZoom(Math.floor(z * 1000) / 1000)
}

/**
 * The zoom a fit command asks for in a design whose pages differ in size: `fit-page` makes the page in view
 * (`active`) fit the viewport, `fit-width` makes the widest page fit its width, so no page needs a horizontal scroll.
 */
export function fitZoomForPages(viewport: Size, active: Size, widest: number, mode: 'fit-width' | 'fit-page', padding = 48): number {
  return fitZoom(viewport, mode === 'fit-width' ? { width: widest, height: active.height } : active, mode, padding)
}

export function nextZoomStep(current: number, direction: 1 | -1): number {
  const eps = 1e-3
  if (direction === 1) return ZOOM_STEPS.find((s) => s > current + eps) ?? MAX_ZOOM
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current - eps) return ZOOM_STEPS[i]
  return MIN_ZOOM
}

/** Multiplicative zoom for a wheel/pinch delta (positive deltaY zooms out). */
export function wheelZoom(current: number, deltaY: number): number {
  return clampZoom(current * Math.exp(-deltaY * 0.0022))
}

export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)}%`
}
