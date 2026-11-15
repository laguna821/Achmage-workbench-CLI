/** Shared by the existing pointer menu and anchored popovers. Disabled choices stay readable. */
export function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[data-menu-item], [role^="menuitem"]')).filter(item => item.closest('[role="menu"]') === menu && !item.hidden && !item.matches(":disabled"));
}

export function moveMenuFocus(menu: HTMLElement, key: string): boolean {
  const items = menuItems(menu);
  if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = key === "Home" ? 0 : key === "End" ? items.length - 1
    : current < 0 ? (key === "ArrowUp" ? items.length - 1 : 0)
    : (current + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus({ preventScroll: true });
  items[next]?.scrollIntoView?.({ block: "nearest" });
  return true;
}

/** Do not steal focus from the dialog or field opened by a menu action. */
export function restoreSurfaceFocus(opener: Element | null, surface: HTMLElement | null) {
  // A modal <dialog> still open makes everything outside it inert, and focus() on an inert element
  // does nothing (skin 2 fix 1: closing 알림 left the focus on the page's body). Close it first.
  if (typeof HTMLDialogElement !== "undefined" && surface instanceof HTMLDialogElement && surface.open && typeof surface.close === "function") surface.close();
  if (!(opener instanceof HTMLElement) || !opener.isConnected) return;
  const active = document.activeElement;
  if (!active || active === document.body || surface?.contains(active)) {
    opener.focus({ preventScroll: true });
    // A key shown only under the hand or the keyboard (a row's ⋯ or +) is hidden once its menu took the
    // focus, and refuses it: the focus goes to the nearest focusable thing that holds it (its row).
    if (document.activeElement !== opener) opener.parentElement?.closest<HTMLElement>("[tabindex], button, a[href], input, textarea, select")?.focus({ preventScroll: true });
  }
}
