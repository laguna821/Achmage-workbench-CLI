import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
} from "react";
import { Icon, iconName, type IconName } from "../Icon.tsx";
import { AnchoredLayer, type AnchoredLayerProps, type LayerAnchor, type LayerCloseReason } from "./AnchoredLayer.tsx";
import { findTypeahead } from "./overlay.ts";

export type MenuAnchor = LayerAnchor;
export type MenuCloseReason = LayerCloseReason;

/** Props shared by Menu and the list layer under Select. */
export type MenuProps = Omit<AnchoredLayerProps, "role" | "initialFocus" | "scrollRef" | "onOpen" | "onKeyDown" | "label"> & {
  /** Accessible name of the list. */
  label: string;
  /** "first"/"last" (opened with Home/End or ArrowUp), otherwise the checked/selected item or the first. */
  initialActive?: "checked" | "first" | "last";
};

export type ListLayerProps = MenuProps & {
  role: "menu" | "listbox";
  /** A visible search field instead of the hidden type-ahead field. */
  search?: { query: string; onQuery: (query: string) => void; label: string; placeholder?: string };
  listId?: string;
  /** When this changes the first item becomes active (a search query). */
  resetKey?: string;
  footer?: ReactNode;
};

type ListContextValue = {
  role: "menu" | "listbox";
  activeId: string | null;
  setActive: (id: string | null) => void;
  close: (reason: LayerCloseReason) => void;
  typeahead: (text: string) => void;
  endTypeahead: () => void;
  typing: () => boolean;
  listId: string;
  label: string;
};

const ListContext = createContext<ListContextValue | null>(null);
const TYPEAHEAD_MS = 700;

const allItems = (list: HTMLElement | null) => (list ? Array.from(list.querySelectorAll<HTMLElement>("[data-menu-item]")) : []);
const isDisabled = (item: HTMLElement) => item.getAttribute("aria-disabled") === "true";
const itemText = (item: HTMLElement) => item.dataset.text ?? item.querySelector(".ui-menu-text")?.textContent ?? "";

/** The list state for a field or row inside a Menu/Select. */
export function useMenuList() {
  const value = useContext(ListContext);
  if (!value) throw new Error("useMenuList outside a menu");
  return value;
}

/**
 * The focused field of a list layer. Visible as a search box, or hidden as the type-ahead field:
 * an IME composes only into an editable element, so typing Hangul needs a real input.
 */
export function MenuField({ fieldRef, search }: { fieldRef: RefObject<HTMLInputElement | null>; search?: ListLayerProps["search"] }) {
  const list = useMenuList();
  const composing = useRef(false);
  const timer = useRef(0);
  const [typed, setTyped] = useState("");
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const reset = () => {
    if (composing.current) return;
    setTyped("");
    list.endTypeahead();
  };
  const later = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(reset, TYPEAHEAD_MS); };
  const input = <input ref={fieldRef} role="combobox" aria-expanded aria-haspopup={list.role} aria-controls={list.listId}
    aria-autocomplete={search ? "list" : "none"} aria-activedescendant={list.activeId ?? undefined} aria-label={search ? search.label : list.label}
    data-search={search ? "" : undefined} data-typing={typed ? "" : undefined} className={search ? "ui-select-search-input" : "ui-menu-typeahead"}
    value={search ? search.query : typed} placeholder={search ? search.placeholder ?? "찾기" : undefined} autoComplete="off" spellCheck={false}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; if (!search) later(); }}
    onChange={event => {
      const text = event.target.value;
      if (search) { search.onQuery(text); return; }
      setTyped(text);
      list.typeahead(text.trimStart());
      later();
    }} />;
  return search ? <div className="ui-select-search"><Icon name="search" size={14} />{input}</div> : input;
}

/** Menu and Select's list engine on an AnchoredLayer: arrows, Home/End, type-ahead, Enter/Space, Tab out. */
export function ListLayer({ role, label, search, listId: givenListId, initialActive = "checked", resetKey, footer, children, className = "", ...layer }: ListLayerProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const ownListId = useId();
  const listId = givenListId ?? ownListId;
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const typed = useRef({ text: "", start: 0 });
  const closeRef = useRef(layer.onClose);
  closeRef.current = layer.onClose;
  const close = useCallback((reason: LayerCloseReason) => closeRef.current(reason), []);

  const activate = useCallback((item: HTMLElement | undefined) => {
    if (!item) return;
    setActiveId(item.id);
    item.scrollIntoView?.({ block: "nearest" });
  }, []);

  // Disabled items stay reachable (their reason is read out); they just cannot be chosen.
  const move = (key: string) => {
    const items = allItems(listRef.current);
    if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
    const current = items.findIndex(item => item.id === activeIdRef.current);
    const next = key === "Home" ? 0 : key === "End" ? items.length - 1
      : current < 0 ? (key === "ArrowUp" ? items.length - 1 : 0)
      : (current + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    activate(items[next]);
    return true;
  };

  const choose = () => {
    const item = activeIdRef.current ? document.getElementById(activeIdRef.current) : null;
    if (!item || !listRef.current?.contains(item) || isDisabled(item)) return;
    item.click();
  };

  const endTypeahead = useCallback(() => { typed.current = { text: "", start: 0 }; }, []);
  /** `text` is everything typed in this burst (the type-ahead field's value). */
  const typeahead = useCallback((text: string) => {
    const items = allItems(listRef.current).filter(item => !isDisabled(item));
    if (!items.length || !text) return;
    const current = items.findIndex(item => item.id === activeIdRef.current);
    const chars = [...text];
    if (!typed.current.text) typed.current.start = current + 1;
    typed.current.text = text;
    const repeated = chars.length > 1 && chars.every(char => char === chars[0]);
    const found = findTypeahead(items.map(itemText), repeated ? chars[0]! : text, repeated ? current + 1 : typed.current.start);
    if (found >= 0) activate(items[found]);
  }, [activate]);

  const onOpen = () => {
    endTypeahead();
    const items = allItems(listRef.current);
    const enabled = items.filter(item => !isDisabled(item));
    const checked = enabled.find(item => item.getAttribute("aria-checked") === "true" || item.getAttribute("aria-selected") === "true");
    const first = initialActive === "last" ? enabled.at(-1) : initialActive === "first" ? enabled[0] : checked ?? enabled[0];
    setActiveId(first?.id ?? null);
    first?.scrollIntoView?.({ block: "nearest" });
  };

  // A new query makes the first match active, never a pinned action row (none when nothing matches).
  // Not on the opening itself: the checked row chosen by onOpen stands.
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!layer.open || !wasOpen.current || resetKey === undefined) return;
    const first = allItems(listRef.current).find(item => !isDisabled(item) && item.dataset.pinned === undefined);
    setActiveId(first?.id ?? null);
    listRef.current?.scrollTo?.({ top: 0 });
  }, [resetKey]);
  useLayoutEffect(() => { wasOpen.current = layer.open; }, [layer.open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const searching = (event.target as HTMLElement).dataset?.search !== undefined;
    if (!(searching && (event.key === "Home" || event.key === "End")) && move(event.key)) event.preventDefault();
    else if (event.key === "Enter" || (event.key === " " && !searching && !typed.current.text)) { event.preventDefault(); choose(); }
  };

  const contextValue = useMemo<ListContextValue>(() => ({
    role, activeId, setActive: setActiveId, close, typeahead, endTypeahead, typing: () => Boolean(typed.current.text), listId, label,
  }), [role, activeId, close, typeahead, endTypeahead, listId, label]);

  return (
    <AnchoredLayer {...layer} role="none" className={`ui-menu ${className}`} initialFocus={fieldRef} scrollRef={listRef} onOpen={onOpen} onKeyDown={onKeyDown}>
      <ListContext.Provider value={contextValue}>
        <MenuField fieldRef={fieldRef} search={search} />
        <div ref={listRef} id={listId} className="ui-menu-list" role={role} aria-label={label} tabIndex={-1}>
          {children}
        </div>
        {footer}
      </ListContext.Provider>
    </AnchoredLayer>
  );
}

/** A menu of actions or choices, opened beside an element or at a point. */
export function Menu(props: MenuProps) {
  return <ListLayer {...props} role="menu" />;
}

export type MenuItemProps = {
  children: ReactNode;
  /** Runs on click or Enter/Space, then the menu closes (unless `keepOpen`). */
  onSelect?: () => void;
  /** A Lucide icon name or any 16px node, in the left column. */
  icon?: IconName | ReactNode;
  /** Right-aligned secondary text: the current value of a setting, a count, a status. */
  hint?: ReactNode;
  /** Right-aligned key hint, drawn as a key cap. */
  shortcut?: string;
  /** A trailing › for an item that opens more choices (another menu or a dialog). */
  more?: boolean;
  /** "checkbox" or "radio" make a checkable item; `checked` alone implies "checkbox". */
  type?: "item" | "checkbox" | "radio";
  checked?: boolean;
  disabled?: boolean;
  /** Shown under the label when disabled (nothing is shown without one). */
  disabledReason?: string;
  danger?: boolean;
  keepOpen?: boolean;
  /** Text for type-ahead when the label is not plain text. */
  textValue?: string;
  /** Rendered as `data-value`, for scripts and tests that pick an item by id. */
  value?: string;
  /** An action pinned after the choices (e.g. "새 프로젝트"): never made active by a search, only by arrows. */
  pinned?: boolean;
  title?: string;
  className?: string;
};

/** One row: [16px icon][label][hint · shortcut · ›][✓]. */
export function MenuItem({ children, onSelect, icon, hint, shortcut, more, type, checked, disabled, disabledReason, danger, keepOpen, textValue, value, pinned, title, className = "" }: MenuItemProps) {
  const surface = useMenuList();
  const id = useId();
  const reasonId = `${id}-reason`;
  const kind = type ?? (checked !== undefined ? "checkbox" : "item");
  const role = surface.role === "listbox" ? "option" : kind === "checkbox" ? "menuitemcheckbox" : kind === "radio" ? "menuitemradio" : "menuitem";
  const active = surface.activeId === id;
  const glyph = typeof icon === "string" ? iconName(icon) : null;
  const iconNode = glyph ? <Icon name={glyph} size={16} /> : icon ?? null;
  return (
    <div id={id} role={role} data-menu-item="" data-text={textValue} data-value={value} data-pinned={pinned ? "" : undefined} data-active={active || undefined}
      aria-checked={role === "option" || kind === "item" ? undefined : Boolean(checked)}
      aria-selected={role === "option" ? Boolean(checked) : undefined}
      aria-disabled={disabled || undefined} aria-describedby={disabled && disabledReason ? reasonId : undefined}
      className={`ui-menu-item${danger ? " danger" : ""} ${className}`} title={title}
      onPointerMove={() => { if (!disabled && !active) surface.setActive(id); }}
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
        if (!keepOpen) surface.close("select");
      }}>
      <span className="ui-menu-icon" aria-hidden>{iconNode}</span>
      <span className="ui-menu-text">{children}{disabled && disabledReason ? <small className="ui-menu-reason" id={reasonId}>{disabledReason}</small> : null}</span>
      {hint !== undefined && hint !== null && hint !== "" ? <span className="ui-menu-hint">{hint}</span> : null}
      {shortcut ? <kbd className="ui-menu-shortcut">{shortcut}</kbd> : null}
      {more ? <Icon name="chevronRight" size={14} className="ui-menu-more" /> : null}
      <span className="ui-menu-check" aria-hidden>{checked ? <Icon name="check" size={16} /> : null}</span>
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="ui-menu-separator" />;
}

/** A small heading row; `hint` sits on the right (e.g. the shortcut that opens this menu). */
export function MenuLabel({ children, hint, id }: { children: ReactNode; hint?: ReactNode; id?: string }) {
  return <div className="ui-menu-heading" id={id} role="presentation"><span>{children}</span>{hint ? <kbd className="ui-menu-shortcut">{hint}</kbd> : null}</div>;
}

/** Items under a heading, announced as a group. */
export function MenuGroup({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return <div role="group" aria-labelledby={id} className="ui-menu-group"><MenuLabel id={id} hint={hint}>{label}</MenuLabel>{children}</div>;
}

/**
 * Wiring for a button that opens a Menu: `<button ref={anchorRef} {...triggerProps}>` and
 * `<Menu {...menuProps} label=…>`. Arrow keys on the button open the menu too.
 */
export function useMenuTrigger<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<T>(null);
  const [initialActive, setInitial] = useState<"checked" | "first" | "last">("checked");
  return {
    open, setOpen, anchorRef,
    triggerProps: {
      "aria-haspopup": "menu" as const,
      "aria-expanded": open,
      onClick: () => { setInitial("checked"); setOpen(value => !value); },
      onKeyDown: (event: ReactKeyboardEvent) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        setInitial(event.key === "ArrowUp" ? "last" : "checked");
        setOpen(true);
      },
    },
    menuProps: { open, anchor: anchorRef, onClose: () => setOpen(false), initialActive },
  };
}
