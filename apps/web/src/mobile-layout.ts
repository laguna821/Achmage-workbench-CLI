import { useSyncExternalStore } from "react";
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

/** Paseo's compact composer uses Return for a new line and the visible button to send: on a touch
 * screen only. A narrow window under a mouse keeps the desktop's keys (Return sends), as its controls
 * keep their desktop size (Hallmark merge: input follows the pointer, never the window's width). */
export function compactInput() {
  return window.matchMedia("(pointer: coarse)").matches;
}

/** A phone: a touch screen, or a window under 40rem. What replaces instead of sharing (a document's
 * AI over its document) asks this, never a pane's width — a narrow pane on a desktop is not a phone. */
export const PHONE_LAYOUT = "(pointer: coarse), (width < 40rem)";
const phoneQuery = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_LAYOUT) : null);
export const isPhoneLayout = () => Boolean(phoneQuery()?.matches);
const watchPhone = (changed: () => void) => {
  const query = phoneQuery();
  query?.addEventListener?.("change", changed);
  window.addEventListener("resize", changed);
  return () => { query?.removeEventListener?.("change", changed); window.removeEventListener("resize", changed); };
};
export const usePhoneLayout = () => useSyncExternalStore(watchPhone, isPhoneLayout, () => false);

/** A phone-width window (under 40rem): the top bar keeps the list key, the place's name, 확인 N and ⋯. */
export const PHONE_WIDTH = "(width < 40rem)";
const widthQuery = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_WIDTH) : null);
const watchWidth = (changed: () => void) => {
  const query = widthQuery();
  query?.addEventListener?.("change", changed);
  return () => query?.removeEventListener?.("change", changed);
};
export const isPhoneWidth = () => Boolean(widthQuery()?.matches);
export const usePhoneWidth = () => useSyncExternalStore(watchWidth, isPhoneWidth, () => false);
