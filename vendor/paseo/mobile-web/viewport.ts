// Extracted from Paseo 1fff127f45b11c1c9c573fbbd12791673004c912, Apache-2.0.
// Original modules and their hashes are preserved in upstream/ and source.json.
export interface ComposerSlotFrame {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function readVisibleViewport() {
  const viewport = window.visualViewport;
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

export function resolveVisibleSurfaceFrame(
  surface: { top: number; left: number; right: number; bottom: number },
  viewport: { top: number; left: number; width: number; height: number },
): ComposerSlotFrame {
  const top = Math.max(viewport.top, surface.top);
  const left = Math.max(viewport.left, surface.left);
  return {
    top,
    left,
    width: Math.max(0, Math.min(viewport.left + viewport.width, surface.right) - left),
    height: Math.max(0, Math.min(viewport.top + viewport.height, surface.bottom) - top),
  };
}
