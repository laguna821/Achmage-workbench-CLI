import { readVisibleViewport, resolveVisibleSurfaceFrame } from "../../../vendor/paseo/mobile-web/viewport.ts";
import "./mobile-layout.css";

/** Install once for the web shell. Resize the existing surface; do not remount editors or lists. */
export function installMobileLayout() {
  const root = document.documentElement;
  const compact = window.matchMedia("(max-width: 900px)");
  const touch = window.matchMedia("(pointer: coarse)");
  const viewport = window.visualViewport;
  let frame = 0;
  const update = () => {
    frame = 0;
    if (!(compact.matches || touch.matches)) {
      delete root.dataset.mobileLayout;
      delete root.dataset.mobileKeyboard;
      return;
    }
    // A pinch zoom remains a browser operation; do not resize the document underneath it.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const visible = resolveVisibleSurfaceFrame(
      { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight },
      readVisibleViewport(),
    );
    root.dataset.mobileLayout = "";
    root.style.setProperty("--mobile-top", visible.top + "px");
    root.style.setProperty("--mobile-left", visible.left + "px");
    root.style.setProperty("--mobile-width", visible.width + "px");
    root.style.setProperty("--mobile-height", visible.height + "px");
    const input = document.activeElement;
    const editing = input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || (input instanceof HTMLElement && input.isContentEditable);
    root.dataset.mobileKeyboard = editing && window.innerHeight - visible.height > 100 ? "open" : "closed";
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const events = ["resize", "orientationchange", "pageshow", "focusin", "focusout"] as const;
  for (const event of events) window.addEventListener(event, schedule);
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  document.addEventListener("visibilitychange", schedule);
  compact.addEventListener("change", schedule);
  touch.addEventListener("change", schedule);
  update();
  return () => {
    cancelAnimationFrame(frame);
    for (const event of events) window.removeEventListener(event, schedule);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    document.removeEventListener("visibilitychange", schedule);
    compact.removeEventListener("change", schedule);
    touch.removeEventListener("change", schedule);
    delete root.dataset.mobileLayout;
    delete root.dataset.mobileKeyboard;
    for (const key of ["top", "left", "width", "height"]) root.style.removeProperty("--mobile-" + key);
  };
}

/** Paseo's compact composer uses Return for a new line and the visible button to send. */
export function compactInput() {
  return window.matchMedia("(max-width: 900px), (pointer: coarse)").matches;
}
