import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import { lookStyle, NEUTRAL_LOOK, useAppearance } from "../appearance.ts";

// Right-click menus (sidebar rows, tabs): groups, submenus, shortcut hints, a red "danger" item.
// Opens at the pointer and stays inside the window; works fully from the keyboard (↑↓ move,
// → opens a submenu, ← closes it, Enter chooses, Esc closes).

export type MenuEntry =
  | { kind: "item"; label: string; icon?: IconName; hint?: string; danger?: boolean; disabled?: boolean; checked?: boolean; onSelect: () => void }
  | { kind: "submenu"; label: string; icon?: IconName; items: MenuEntry[]; disabled?: boolean }
  | { kind: "separator" }
  | { kind: "label"; label: string };

export type MenuRequest = { x: number; y: number; title?: string; items: MenuEntry[] };

const selectable = (entry: MenuEntry) => (entry.kind === "item" || entry.kind === "submenu") && !entry.disabled;

function MenuList({
  items,
  x,
  y,
  title,
  depth,
  flipX,
  onClose,
  onBack,
}: {
  items: MenuEntry[];
  x: number;
  y: number;
  title?: string;
  depth: number;
  /** For a submenu: where its right edge goes when there is no room on the right (the parent's left). */
  flipX?: number;
  onClose: () => void;
  onBack?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { appTheme } = useAppearance();
  const [position, setPosition] = useState({ left: x, top: y });
  const [active, setActive] = useState(() => (depth > 0 ? items.findIndex(selectable) : -1));
  const [open, setOpen] = useState<{ index: number; x: number; y: number; flipX: number } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);

  // Keep the menu inside the window (a submenu flips to the left when there is no room).
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 6) left = flipX !== undefined ? flipX - rect.width : window.innerWidth - rect.width - 6;
    if (top + rect.height > window.innerHeight - 6) top = Math.max(6, window.innerHeight - rect.height - 6);
    setPosition({ left: Math.max(6, left), top });
  }, [x, y, flipX]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const openSubmenu = (index: number) => {
    const row = ref.current?.querySelectorAll<HTMLElement>("[data-menu-index]")[index];
    const entry = items[index];
    if (!row || !entry || entry.kind !== "submenu" || entry.disabled) return;
    const rect = row.getBoundingClientRect();
    const menu = ref.current?.getBoundingClientRect();
    setOpen({ index, x: rect.right - 4, y: rect.top - 6, flipX: (menu?.left ?? rect.left) + 4 });
  };

  const choose = (index: number) => {
    const entry = items[index];
    if (!entry || !selectable(entry)) return;
    if (entry.kind === "submenu") return openSubmenu(index);
    if (entry.kind === "item") {
      onClose();
      entry.onSelect();
    }
  };

  const step = (direction: 1 | -1) => {
    if (!items.some(selectable)) return;
    let next = active;
    for (let guard = 0; guard < items.length; guard += 1) {
      next = (next + direction + items.length) % items.length;
      if (selectable(items[next]!)) break;
    }
    setActive(next);
  };

  return (
    <>
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        className="context-menu look-scope"
        data-theme={appTheme}
        style={{ ...lookStyle(NEUTRAL_LOOK[appTheme]), left: position.left, top: position.top }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (open) return;
          if (event.key === "ArrowDown") step(1);
          else if (event.key === "ArrowUp") step(-1);
          else if (event.key === "ArrowRight" && active >= 0 && items[active]?.kind === "submenu") openSubmenu(active);
          else if (event.key === "ArrowLeft" && onBack) onBack();
          else if (event.key === "Enter" || event.key === " ") {
            if (active >= 0) choose(active);
          } else if (event.key === "Escape") onClose();
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {title ? <div className="context-menu-title">{title}</div> : null}
        {items.map((entry, index) => {
          if (entry.kind === "separator") return <div key={index} className="context-menu-separator" role="separator" />;
          if (entry.kind === "label") return <div key={index} className="context-menu-label">{entry.label}</div>;
          const isSubmenu = entry.kind === "submenu";
          return (
            <button
              key={index}
              type="button"
              role="menuitem"
              data-menu-index
              aria-haspopup={isSubmenu ? "menu" : undefined}
              aria-expanded={isSubmenu ? open?.index === index : undefined}
              disabled={entry.disabled}
              className={`context-menu-item${active === index ? " active" : ""}${entry.kind === "item" && entry.danger ? " danger" : ""}`}
              onPointerEnter={() => {
                setActive(index);
                window.clearTimeout(hoverTimer.current);
                if (isSubmenu) hoverTimer.current = window.setTimeout(() => openSubmenu(index), 120);
                else setOpen(null);
              }}
              onClick={() => choose(index)}
            >
              <span className="context-menu-icon">{entry.icon ? <Icon name={entry.icon} size={16} /> : entry.kind === "item" && entry.checked ? <Icon name="check" size={16} /> : null}</span>
              <span className="context-menu-text">{entry.label}</span>
              {entry.kind === "item" && entry.hint ? <span className="context-menu-hint">{entry.hint}</span> : null}
              {isSubmenu ? <Icon name="chevronRight" size={14} className="context-menu-more" /> : null}
            </button>
          );
        })}
      </div>
      {open && items[open.index]?.kind === "submenu" ? (
        <MenuList
          key={open.index}
          items={(items[open.index] as Extract<MenuEntry, { kind: "submenu" }>).items}
          x={open.x}
          y={open.y}
          flipX={open.flipX}
          depth={depth + 1}
          onClose={onClose}
          onBack={() => {
            setOpen(null);
            ref.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

/** A right-click menu at the pointer; closes on choice, Esc, a click elsewhere, scroll or resize. */
export function ContextMenu({ request, onClose }: { request: MenuRequest; onClose: () => void }) {
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".context-menu")) onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);
  return (
    <div className="context-menu-layer">
      <MenuList items={request.items} x={request.x} y={request.y} title={request.title} depth={0} onClose={onClose} />
    </div>
  );
}
