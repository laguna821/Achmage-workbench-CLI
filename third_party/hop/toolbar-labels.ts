// From Achmage HOP @ d533eb4360db034cd45d87b0751c0d742c6d6ca6 (apps/studio-host/src/host/toolbar-labels.ts). MIT; see LICENSE.
// HOP's toolbar label layer: 보기 › 도구 상자 라벨 표시 shows or hides the labels under the icon row's keys (and the
// format row's group labels), remembered on this computer. Adapted: it runs on the studio frame's own document and
// puts its own entry in the studio's 보기 menu (the studio's command registry is not reachable from outside), so the
// entry is a checkbox of its own that closes the menu as the studio's entries do.
const STORAGE_KEY = "hop.toolbar-labels";
const ENTRY = "wb-toolbar-labels";

function apply(doc: Document, visible: boolean): void {
  doc.documentElement.dataset.toolbarLabels = visible ? "shown" : "hidden";
  for (const item of doc.querySelectorAll(`[data-wb-cmd="${ENTRY}"]`)) {
    item.classList.toggle("active", visible);
    item.setAttribute("aria-checked", String(visible));
  }
}

function read(storage: Storage | null): boolean {
  try { return storage?.getItem(STORAGE_KEY) !== "hidden"; }
  catch { return true; }
}

/** Install the label layer and its 보기 entry in a studio document. Returns its removal. */
export function installToolbarLabels(doc: Document): () => void {
  const view = doc.defaultView;
  let storage: Storage | null = null;
  try { storage = view?.localStorage ?? null; } catch { storage = null; }
  const menu = doc.querySelector('#menu-bar .menu-item[data-menu="view"] > .menu-dropdown');
  let item: HTMLElement | null = null;
  if (menu && !menu.querySelector(`[data-wb-cmd="${ENTRY}"]`)) {
    item = doc.createElement("div");
    item.className = "md-item";
    item.setAttribute("role", "menuitemcheckbox");
    item.dataset.wbCmd = ENTRY;
    const icon = doc.createElement("span"); icon.className = "md-icon";
    const label = doc.createElement("span"); label.className = "md-label"; label.textContent = "도구 상자 라벨 표시";
    item.append(icon, label);
    // right after the studio's own 도구 상자 submenu (기본 / 서식), else at the end of 보기
    const anchor = menu.querySelector('[data-cmd="view:toolbox-basic"]')?.closest(".md-sub");
    if (anchor) anchor.after(item); else menu.append(item);
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      const visible = doc.documentElement.dataset.toolbarLabels === "hidden";
      apply(doc, visible);
      try { storage?.setItem(STORAGE_KEY, visible ? "shown" : "hidden"); }
      catch { /* Keep the current window usable when storage is unavailable. */ }
      // close the menu as the studio's own entries do (its menu bar closes on Escape)
      doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  }
  apply(doc, read(storage));
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) apply(doc, read(storage)); };
  view?.addEventListener("storage", onStorage);
  return () => {
    view?.removeEventListener("storage", onStorage);
    item?.remove();
    delete doc.documentElement.dataset.toolbarLabels;
  };
}
