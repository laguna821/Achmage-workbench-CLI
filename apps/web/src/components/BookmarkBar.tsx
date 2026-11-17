import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BookmarkFolder, BookmarkItem, BookmarkNode } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { bookmarkLetter, countBookmarks, findBookmark, fitCount, folderTargets, placeOf, shortTitle, typedAddress, useBookmarkIcon, useBookmarks } from "../bookmarks.ts";
import type { Notify } from "../top-notice.ts";
import { comboOf } from "../shortcuts.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ContextMenu, type MenuEntry, type MenuRequest } from "./ContextMenu.tsx";
import { Icon } from "./Icon.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";

// The bookmark bar of a web tab (bookmarks unit, 0.5.1; the owner: "즐겨찾기가 상단 주소 바로 밑에 즐겨찾기 줄
// 엣지 브라우저식으로 표시되고 우클릭으로 추가할수도 있게"). One quiet row directly under the address row: items
// (the site's icon — a letter mark until the gateway has one — and the name, cut), folders as keys that open
// a menu of their items (folders inside as sub-menus), "»" for what does not fit. The same set in every project.
// bookmarks2 (0.5.4): an item in a folder's menu has the same menu as one on the bar (right-click, or the
// menu key on it): 이름 바꾸기 / 주소 고치기 / 옮기기 (up, down, to the bar, into a folder) / 삭제 with
// 되돌리기; a bar item dragged onto a folder goes into it; the keys also come from a page that has the focus.
// A click opens the page in THIS web tab; a middle click or Ctrl/⌘-click opens a new web tab. The star at
// the end of the address field adds the page; right-click adds and edits, as a browser does. No bookmarks
// yet → no bar. The bar is a toolbar: one Tab stop, arrows move, Enter opens, the menu key opens the menu.

type Requester = Pick<Api, "request">;
type Prompt = { title: string; label: string; value: string; submit: string; address?: boolean; save(value: string): Promise<unknown> };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A page that can be kept: an http(s) address (not the blank new-tab page). */
const keepable = (url: string | undefined | null): url is string => !!url && /^https?:\/\//i.test(url);

/**
 * A bookmark's mark: its site's icon once the gateway has one, its first letter until then — in the same
 * 16 px box, so nothing moves when the icon arrives. In a menu the letter is drawn by CSS (`data-letter`),
 * so the entry's text stays the name alone.
 */
export function SiteMark({ api, node, menu }: { api: Requester; node: BookmarkItem; menu?: boolean }) {
  const src = useBookmarkIcon(api, node.icon), letter = bookmarkLetter(node.title);
  return <span className="bookmark-mark" data-letter={menu && !src ? letter : undefined} data-icon={src ? "" : undefined} aria-hidden>
    {src ? <img src={src} alt="" width={16} height={16} draggable={false} /> : menu ? null : letter}
  </span>;
}

/** One line to type: a name or an address (the dialog recipe of RenameDialog). */
function TextPrompt({ prompt, onClose }: { prompt: Prompt; onClose(): void }) {
  const [value, setValue] = useState(prompt.value), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useLayoutEffect(() => () => restoreSurfaceFocus(opener.current, null), []);
  const save = () => {
    const next = prompt.address ? typedAddress(value) : value.trim();
    if (!next || next === prompt.value) return onClose();
    setBusy(true); setError("");
    void prompt.save(next).then(onClose, reason => { setError(message(reason)); setBusy(false); });
  };
  return <div className="modal-backdrop" onMouseDown={event => !busy && event.target === event.currentTarget && onClose()} onKeyDown={event => { event.stopPropagation(); if (!busy && event.key === "Escape") onClose(); }}>
    <form className="nav-dialog" role="dialog" aria-modal="true" aria-label={prompt.title} onSubmit={event => { event.preventDefault(); save(); }}>
      <h2>{prompt.title}</h2>
      <input value={value} onChange={event => setValue(event.target.value)} aria-label={prompt.label} autoFocus disabled={busy} spellCheck={false} autoCapitalize={prompt.address ? "none" : undefined} inputMode={prompt.address ? "url" : undefined} />
      {error ? <p role="alert">{error}</p> : null}
      <div className="nav-dialog-foot">
        <button type="button" className="button" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className="button primary" disabled={busy}>{prompt.submit}</button>
      </div>
    </form>
  </div>;
}

/**
 * A web tab's bookmarks: `star` goes at the end of the address field, `bar` directly under the address
 * row. `page`: the page this tab shows; `onOpen(url, newTab)`; `active`: this tab is the one on screen
 * (Ctrl/⌘+D and Ctrl/⌘+Shift+B answer there).
 */
export type PageChord = "bookmark" | "bookmark-bar";
export function useBookmarkUi({ api, page, onOpen, active, notify }: {
  api: Requester; page: { url: string; title: string } | null; onOpen(url: string, newTab: boolean): void; active: boolean;
  /** The app's notice (a removal says so there, with 되돌리기). */
  notify?: Notify;
}): { star: ReactNode; bar: ReactNode; press(chord: PageChord): void } {
  const [data, client] = useBookmarks(api);
  const [menu, setMenuState] = useState<(MenuRequest & { owner?: string; serial: number }) | null>(null);
  const serial = useRef(0);
  /** Each menu is a new one: it takes the focus afresh. */
  const setMenu = (request: (MenuRequest & { owner?: string }) | null) => setMenuState(request ? { ...request, serial: ++serial.current } : null);
  /**
   * The menu of an entry INSIDE a folder's menu, laid over it (the folder's menu stays open under it, as in a
   * browser): Esc closes it alone and the focus goes back to that entry; a choice in it closes both.
   */
  const [inner, setInnerState] = useState<(MenuRequest & { serial: number }) | null>(null);
  const setInner = (request: MenuRequest | null) => setInnerState(request ? { ...request, serial: ++serial.current } : null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [removal, setRemoval] = useState<BookmarkFolder | null>(null);
  const [error, setError] = useState("");
  const [fit, setFit] = useState(Number.MAX_SAFE_INTEGER);
  const [focusAt, setFocusAt] = useState(0);
  const [dragging, setDragging] = useState<{ id: string; to: number; into?: string } | null>(null);
  const row = useRef<HTMLDivElement>(null), starKey = useRef<HTMLButtonElement>(null);
  /** Was the choice in a menu made with Ctrl/⌘ held (a new tab)? Read from the click itself. */
  const modified = useRef(false);
  const drag = useRef<{ id: string; from: number; x: number; moved: boolean } | null>(null), dragged = useRef(false);
  /** The item that keeps the focus when it moves along the bar (the DOM may move its key). */
  const refocus = useRef<string | null>(null);

  const items = data?.items ?? [];
  const shown = Boolean(data?.showBar && items.length);
  const here = keepable(page?.url) ? page : null;
  const kept = here ? findBookmark(items, here.url) : null;
  const attempt = (action: Promise<unknown>) => { setError(""); void action.catch(reason => setError(message(reason))); };
  /** Opening a bookmark is the one moment its site is asked for an icon (when it has none yet). */
  const open = (url: string, newTab: boolean, node?: BookmarkItem) => {
    onOpen(url, newTab);
    if (node && !node.icon) void client.fetchIcon(node.url).catch(() => undefined);
  };

  // How many items fit: every item is laid out (the ones that do not fit are only unseen), so their
  // right edges are always there to measure; "»" takes its width from the row, which is measured again.
  const measure = () => {
    const element = row.current;
    if (!element) return;
    const keys = Array.from(element.querySelectorAll<HTMLElement>("[data-bookmark]"));
    setFit(fitCount(keys.map(key => key.offsetLeft + key.offsetWidth), element.clientWidth));
  };
  useLayoutEffect(() => {
    if (!shown) return;
    measure();
    const element = row.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown, data]);
  const visible = Math.min(fit, items.length);
  useLayoutEffect(() => {
    const id = refocus.current; refocus.current = null;
    if (id) Array.from(row.current?.querySelectorAll<HTMLElement>("[data-bookmark]") ?? []).find(key => key.dataset.bookmark === id)?.focus();
  }, [data]);

  useEffect(() => {
    if (!menu) return;
    const click = (event: MouseEvent) => { modified.current = event.ctrlKey || event.metaKey; };
    const key = () => { modified.current = false; };
    document.addEventListener("click", click, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("click", click, true); document.removeEventListener("keydown", key, true); };
  }, [menu]);

  const addHere = () => { if (here && !kept) attempt(client.add({ kind: "item", title: here.title, url: here.url })); };
  const rename = (node: BookmarkNode) => setPrompt({ title: node.kind === "folder" ? "폴더 이름 바꾸기" : "즐겨찾기 이름 바꾸기", label: "이름", value: node.title, submit: "바꾸기", save: title => client.update(node.id, { title }) });
  const readdress = (node: BookmarkItem) => setPrompt({ title: "즐겨찾기 주소 고치기", label: "주소", value: node.url, submit: "고치기", address: true, save: url => client.update(node.id, { url }) });
  /** Removed, and said in the app's notice with 되돌리기 (the node goes back where it was, a folder whole). */
  const removeNow = async (node: BookmarkNode) => {
    const at = placeOf(items, node.id);
    await client.remove(node.id);
    notify?.({ text: `「${shortTitle(node.title, 30)}」 ${node.kind === "folder" ? "폴더" : "즐겨찾기"}를 지웠습니다.`,
      action: { label: "되돌리기", run: () => attempt(client.restore(node, at?.parentId ?? null, at?.index ?? 0)) } });
  };
  const remove = (node: BookmarkNode) => { if (node.kind === "folder" && node.children.length) setRemoval(node); else attempt(removeNow(node)); };
  const newFolder = (parentId: string | null = null) => setPrompt({ title: parentId ? "폴더 안에 새 폴더" : "폴더 추가", label: "폴더 이름", value: "", submit: "추가", save: title => client.add(parentId ? { kind: "folder", title, parentId } : { kind: "folder", title }) });
  const moveTo = (node: BookmarkNode, parentId: string | null, index: number) => attempt(client.move(node.id, parentId, index));

  /** 옮기기: one place up / down (left / right on the bar), to the bar, into another folder. */
  const moveEntries = (node: BookmarkNode): MenuEntry[] => {
    const at = placeOf(items, node.id);
    if (!at) return [{ kind: "label", label: "이미 지운 즐겨찾기입니다." }];
    const onBar = at.parentId === null;
    const targets = folderTargets(items, node.id).filter(target => target.folder.id !== at.parentId);
    return [
      { kind: "item", label: onBar ? "왼쪽으로" : "위로", icon: onBar ? "chevronLeft" : "chevronUp", disabled: at.index === 0, disabledReason: onBar ? "맨 앞에 있습니다." : "맨 위에 있습니다.", onSelect: () => moveTo(node, at.parentId, at.index - 1) },
      { kind: "item", label: onBar ? "오른쪽으로" : "아래로", icon: onBar ? "chevronRight" : "chevronDown", disabled: at.index >= at.siblings - 1, disabledReason: onBar ? "맨 끝에 있습니다." : "맨 아래에 있습니다.", onSelect: () => moveTo(node, at.parentId, at.index + 1) },
      ...(!onBar || targets.length ? [{ kind: "separator" } as MenuEntry] : []),
      ...(!onBar ? [{ kind: "item", label: "즐겨찾기 줄로", icon: "star", onSelect: () => moveTo(node, null, items.length) } as MenuEntry] : []),
      ...targets.map((target): MenuEntry => ({ kind: "item", label: target.path, icon: "folder", onSelect: () => moveTo(node, target.folder.id, target.folder.children.length) })),
    ];
  };

  /** An entry inside a folder's menu has its own menu (right-click, or the menu key on it), as a bar item does. */
  const closingBoth = (entries: MenuEntry[]): MenuEntry[] => entries.map(entry => entry.kind === "item" ? { ...entry, onSelect: () => { setMenu(null); entry.onSelect(); } }
    : entry.kind === "submenu" ? { ...entry, items: closingBoth(entry.items) } : entry);
  const nested = (node: BookmarkNode) => (x: number, y: number) => { const request = itemRequest(node, x, y); setInner({ ...request, items: closingBoth(request.items) }); };
  /** A folder's items as a menu (each with its site's mark); folders inside it as sub-menus. */
  const folderEntries = (nodes: BookmarkNode[]): MenuEntry[] => nodes.length ? nodes.map((node): MenuEntry => node.kind === "folder"
    ? { kind: "submenu", label: shortTitle(node.title, 40), icon: "folder", items: folderEntries(node.children), onContext: nested(node) }
    : { kind: "item", label: shortTitle(node.title, 40), leading: <SiteMark api={api} node={node} menu />, onSelect: () => open(node.url, modified.current, node), onContext: nested(node) }) : [{ kind: "label", label: "비어 있음" }];
  const under = (element: Element) => { const box = element.getBoundingClientRect(); return { x: box.left, y: box.bottom + 2 }; };
  const openFolder = (node: BookmarkFolder, anchor: HTMLElement) => { setMenu({ ...under(anchor), title: node.title, items: folderEntries(node.children), owner: node.id }); };
  const openRest = (anchor: HTMLElement) => { setMenu({ ...under(anchor), title: "나머지 즐겨찾기", items: folderEntries(items.slice(visible)), owner: "rest" }); };
  const itemMenu = (node: BookmarkNode, x: number, y: number) => setMenu(itemRequest(node, x, y));
  function itemRequest(node: BookmarkNode, x: number, y: number): MenuRequest {
    return { x, y, title: node.title, items: node.kind === "item" ? [
      { kind: "item", label: "새 탭에서 열기", icon: "openNew", onSelect: () => open(node.url, true, node) },
      { kind: "separator" },
      { kind: "item", label: "이름 바꾸기", icon: "edit", onSelect: () => rename(node) },
      { kind: "item", label: "주소 고치기", icon: "link", onSelect: () => readdress(node) },
      { kind: "submenu", label: "옮기기", icon: "swap", items: moveEntries(node) },
      { kind: "separator" },
      { kind: "item", label: "삭제", icon: "trash", danger: true, onSelect: () => remove(node) },
    ] : [
      { kind: "item", label: "이름 바꾸기", icon: "edit", onSelect: () => rename(node) },
      { kind: "item", label: "폴더 안에 새 폴더", icon: "folder", onSelect: () => newFolder(node.id) },
      { kind: "submenu", label: "옮기기", icon: "swap", items: moveEntries(node) },
      { kind: "separator" },
      { kind: "item", label: "삭제", icon: "trash", danger: true, onSelect: () => remove(node) },
    ] };
  }
  const barMenu = (x: number, y: number) => setMenu({ x, y, title: "즐겨찾기 줄", items: [
    { kind: "item", label: "이 페이지를 즐겨찾기에 추가", icon: "star", disabled: !here || Boolean(kept), disabledReason: kept ? "이미 즐겨찾기에 있습니다." : "열려 있는 웹 페이지가 없습니다.", onSelect: addHere },
    { kind: "item", label: "폴더 추가", icon: "folder", onSelect: () => newFolder() },
  ] });
  /** The star, and Ctrl/⌘+D: add this page; a page already kept offers 이름 바꾸기 / 삭제. */
  const star = () => {
    if (!here) return;
    if (!kept) return addHere();
    const anchor = starKey.current;
    setMenu({ ...(anchor ? under(anchor) : { x: 24, y: 80 }), title: "이 페이지의 즐겨찾기", items: [
      { kind: "item", label: "이름 바꾸기", icon: "edit", onSelect: () => rename(kept) },
      { kind: "item", label: "삭제", icon: "trash", danger: true, onSelect: () => remove(kept) },
    ] });
  };
  const starAction = useRef(star); starAction.current = star;
  const toggleBar = useRef(() => undefined as void); toggleBar.current = () => { if (data) attempt(client.showBar(!data.showBar)); };

  /** The same two keys pressed while the web page itself has the focus (the native view forwards them). */
  const press = (chord: PageChord) => { if (chord === "bookmark") starAction.current(); else toggleBar.current(); };

  // Ctrl/⌘+D and Ctrl/⌘+Shift+B, where this web tab is on screen. With two web tabs side by side the
  // one the keys were pressed in answers; pressed with nothing focused, the first one does (never both).
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const combo = comboOf(event);
      if (combo !== "Ctrl+D" && combo !== "Ctrl+Shift+B") return;
      const own = starKey.current?.closest(".browser-view") ?? null;
      const from = event.target instanceof Element ? event.target.closest(".browser-view") : null;
      // Typed in a field of another view (a note, a conversation's input): that view's own key, not ours.
      const nowhere = !(event.target instanceof Element) || event.target === document.body || event.target === document.documentElement;
      if (from ? from !== own : !nowhere || document.querySelector("[data-bookmark-keys]") !== starKey.current) return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      event.preventDefault();
      if (combo === "Ctrl+D") starAction.current(); else toggleBar.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active]);

  const keyOf = (index: number) => row.current?.parentElement?.querySelectorAll<HTMLElement>("[data-bar-key]")[index];
  const stops = visible + (visible < items.length ? 1 : 0);
  const focusKey = (index: number) => { const next = Math.max(0, Math.min(stops - 1, index)); setFocusAt(next); keyOf(next)?.focus(); };
  const barKeys = (event: ReactKeyboardEvent, index: number, node: BookmarkNode | null) => {
    if (event.nativeEvent.isComposing) return;
    dragged.current = false;
    const reorder = (event.ctrlKey || event.metaKey) && event.shiftKey;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const step = event.key === "ArrowRight" ? 1 : -1;
      event.preventDefault();
      // Ctrl+Shift+←/→: the focused item moves one place along the bar (the focus stays on it).
      if (reorder) { if (node && index + step >= 0 && index + step < items.length) { setFocusAt(Math.min(index + step, Math.max(0, visible - 1))); refocus.current = node.id; attempt(client.move(node.id, null, index + step)); } return; }
      focusKey(index + step);
    } else if (event.key === "Home") { event.preventDefault(); focusKey(0); }
    else if (event.key === "End") { event.preventDefault(); focusKey(stops - 1); }
    else if (node && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) { event.preventDefault(); const at = under(event.currentTarget); itemMenu(node, at.x, at.y); }
    else if (node?.kind === "folder" && event.key === "ArrowDown") { event.preventDefault(); openFolder(node, event.currentTarget as HTMLElement); }
  };

  // Dragging an item along the bar (pointer events, as the tab strip): it moves once the hand has
  // travelled a little, the place under the hand is marked, and the click that ends a drag opens nothing.
  const pointerDown = (event: ReactPointerEvent<HTMLElement>, node: BookmarkNode, index: number) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
    drag.current = { id: node.id, from: index, x: event.clientX, moved: false }; dragged.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || (!state.moved && Math.abs(event.clientX - state.x) < 6)) return;
    state.moved = true;
    const keys = Array.from(row.current?.querySelectorAll<HTMLElement>("[data-bookmark]") ?? []).slice(0, visible);
    // Over the middle of a folder key: into that folder (at its end).
    const folder = keys.find(key => { const box = key.getBoundingClientRect(); return key.dataset.kind === "folder" && key.dataset.bookmark !== state.id && event.clientX > box.left + box.width / 4 && event.clientX < box.right - box.width / 4; });
    if (folder) { setDragging({ id: state.id, to: -1, into: folder.dataset.bookmark }); return; }
    let to = keys.findIndex(key => { const box = key.getBoundingClientRect(); return event.clientX < box.left + box.width / 2; });
    if (to < 0) to = keys.length;
    // The place among the others once this one has left its own.
    if (to > state.from) to--;
    setDragging({ id: state.id, to });
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const state = drag.current; drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const target = dragging; setDragging(null);
    if (!state?.moved) return;
    dragged.current = true;
    if (commit && target?.into) attempt(client.move(state.id, target.into, Number.MAX_SAFE_INTEGER));
    else if (commit && target && target.to !== state.from) attempt(client.move(state.id, null, target.to));
  };

  /** Where the dragged item would land: a rule before that item, or after the last one. */
  const from = dragging ? items.findIndex(entry => entry.id === dragging.id) : -1;
  const dropMark = (index: number) => {
    if (dragging?.into) return items[index]?.id === dragging.into ? "into" : undefined;
    if (!dragging || index === from || index >= visible) return undefined;
    const at = index > from ? index - 1 : index, last = visible - (from >= 0 && from < visible ? 1 : 0) - 1;
    return at === dragging.to ? "before" : dragging.to > last && at === last ? "after" : undefined;
  };

  const filled = Boolean(kept);
  const starNode = <button ref={starKey} type="button" className="browser-address-go hig-icon-button bookmark-star" data-bookmark-keys={active ? "" : undefined} aria-pressed={filled}
    aria-haspopup={filled ? "menu" : undefined} disabled={!here || !data}
    aria-label={filled ? "즐겨찾기에 있음, 이름 바꾸기 또는 삭제" : "이 페이지를 즐겨찾기에 추가"} title={filled ? "즐겨찾기에 있습니다 (Ctrl+D)" : "이 페이지를 즐겨찾기에 추가 (Ctrl+D)"} onClick={star}>
    <Icon name="star" size={16} />
  </button>;

  const layers = <>
    {menu ? <ContextMenu key={menu.serial} request={menu} onClose={() => { setMenu(null); setInner(null); }} /> : null}
    {menu && inner ? <ContextMenu key={inner.serial} request={inner} onClose={() => setInner(null)} /> : null}
    {prompt ? <TextPrompt prompt={prompt} onClose={() => setPrompt(null)} /> : null}
    {removal ? <ConfirmDialog title="폴더 삭제" confirmLabel="삭제" busyLabel="지우는 중…"
      lines={[`「${removal.title}」 폴더와 그 안의 즐겨찾기 ${countBookmarks(removal.children).items}개를 지웁니다.${notify ? " 지운 뒤 알림의 되돌리기로 되살릴 수 있습니다." : ""}`]}
      onConfirm={() => removeNow(removal)} onClose={() => setRemoval(null)} /> : null}
  </>;

  const bar = <>
    {shown ? <div className="bookmark-bar" role="toolbar" aria-label="즐겨찾기 줄" aria-orientation="horizontal"
      onContextMenu={event => { if ((event.target as Element).closest("[data-bookmark]")) return; event.preventDefault(); barMenu(event.clientX, event.clientY); }}>
      <div className="bookmark-bar-items" ref={row}>
        {items.map((node, index) => {
          const hidden = index >= visible, folder = node.kind === "folder";
          return <button key={node.id} type="button" className="ghost-button bookmark-item" data-bookmark={node.id} data-bar-key={hidden ? undefined : ""} data-kind={node.kind}
            data-overflow={hidden ? "" : undefined} data-dragging={dragging?.id === node.id ? "" : undefined} data-drop={dropMark(index)}
            aria-hidden={hidden || undefined} tabIndex={!hidden && index === Math.min(focusAt, stops - 1) ? 0 : -1}
            aria-label={node.title} title={folder ? node.title : `${node.title}\n${node.url}`}
            aria-haspopup={folder ? "menu" : undefined} aria-expanded={folder ? menu?.owner === node.id : undefined}
            onFocus={() => setFocusAt(index)} onKeyDown={event => barKeys(event, index, node)}
            onPointerDown={event => pointerDown(event, node, index)} onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event, true)} onPointerCancel={event => pointerEnd(event, false)}
            onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
            onClick={event => {
              if (dragged.current) { dragged.current = false; return; }
              if (folder) openFolder(node, event.currentTarget); else open(node.url, event.ctrlKey || event.metaKey, node);
            }}
            onAuxClick={event => { if (event.button === 1 && !folder) { event.preventDefault(); open(node.url, true, node); } }}
            onContextMenu={event => { event.preventDefault(); itemMenu(node, event.clientX, event.clientY); }}>
            {folder ? <ItemIcon kind="folder" size={16} /> : <SiteMark api={api} node={node} />}
            <span className="bookmark-title">{shortTitle(node.title)}</span>
          </button>;
        })}
      </div>
      {visible < items.length ? <button type="button" className="ghost-button bookmark-more" data-bar-key="" aria-label="나머지 즐겨찾기" title="나머지 즐겨찾기" aria-haspopup="menu" aria-expanded={menu?.owner === "rest"}
        tabIndex={Math.min(focusAt, stops - 1) === visible ? 0 : -1} onFocus={() => setFocusAt(visible)} onKeyDown={event => barKeys(event, visible, null)} onClick={event => openRest(event.currentTarget)}>»</button> : null}
    </div> : null}
    {error ? <p role="alert" className="browser-error">{error}</p> : null}
    {typeof document === "undefined" ? null : createPortal(layers, document.body)}
  </>;
  return { star: starNode, bar, press };
}
