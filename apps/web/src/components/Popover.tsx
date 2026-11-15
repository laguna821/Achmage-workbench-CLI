import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { moveMenuFocus, restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import { layerOwns } from "./ui/layers.ts";

// One popover at a time (design rule): opening a new one replaces the current one.
let closeCurrent: (() => void) | null = null;
const MenuContext = createContext(true);

export function Popover({
  open,
  onClose,
  children,
  align = "left",
  placement = "below",
  className,
  role,
  label,
  fitWithinClippingAncestors = false,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right" | "center";
  placement?: "below" | "above";
  className?: string;
  /** A form stays a dialog; plain choices use the shared menu keyboard rules. */
  role?: "menu" | "dialog";
  label?: string;
  /** Keep compact-pane choices inside the pane as well as the window. */
  fitWithinClippingAncestors?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) openerRef.current = document.activeElement;
  wasOpen.current = open;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [detectedRole, setDetectedRole] = useState<"menu" | "dialog">("dialog");
  const [triggerLabel, setTriggerLabel] = useState("");
  const surfaceRole = role ?? detectedRole;
  useLayoutEffect(() => {
    const surface = ref.current;
    if (!open || !surface || !fitWithinClippingAncestors) return;
    const anchor = surface.parentElement!;
    const ancestors: HTMLElement[] = [];
    for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement) ancestors.push(parent);
    const fit = () => {
      let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
      for (const parent of ancestors) {
        const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      const gap = 8, anchorBox = anchor.getBoundingClientRect();
      left += gap; right -= gap; top += gap; bottom -= gap;
      const above = Math.max(0, anchorBox.top - 6 - top), below = Math.max(0, bottom - anchorBox.bottom - 6);
      const side = (placement === "above" ? above : below) >= Math.min(180, Math.max(above, below)) ? placement : placement === "above" ? "below" : "above";
      surface.style.setProperty("--popover-fit-width", `${Math.max(0, right - left)}px`);
      surface.style.setProperty("--popover-fit-height", `${side === "above" ? above : below}px`);
      surface.style.top = side === "below" ? "calc(100% + 6px)" : "auto";
      surface.style.bottom = side === "above" ? "calc(100% + 6px)" : "auto";
      surface.style.translate = "0px";
      const box = surface.getBoundingClientRect();
      const x = Math.max(left, Math.min(box.left, right - box.width)) - box.left;
      const y = Math.max(top, Math.min(box.top, bottom - box.height)) - box.top;
      surface.style.translate = `${x}px ${y}px`;
    };
    fit();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    for (const element of [surface, ...ancestors]) resize?.observe(element);
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, true);
    return () => { resize?.disconnect(); window.removeEventListener("resize", fit); window.removeEventListener("scroll", fit, true); };
  }, [open, placement, fitWithinClippingAncestors]);
  useLayoutEffect(() => {
    if (!open) return;
    const surface = ref.current;
    const opener = openerRef.current;
    const close = () => closeRef.current();
    closeCurrent?.();
    closeCurrent = close;
    setTriggerLabel(opener?.getAttribute("aria-label") ?? opener?.getAttribute("title") ?? opener?.textContent?.trim() ?? "");
    const nextRole = role ?? (surface?.querySelector("input, textarea, select, form, [contenteditable=true]") || !surface?.querySelector('[data-menu-item], [role^="menuitem"]') ? "dialog" : "menu");
    setDetectedRole(nextRole);
    if (surface && !surface.contains(document.activeElement)) {
      const first = nextRole === "menu"
        ? surface.querySelector<HTMLElement>('[aria-checked="true"], [data-menu-active="true"]') ?? surface.querySelector<HTMLElement>('[data-menu-item], [role^="menuitem"]')
        : surface.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex="0"]');
      (first ?? surface).focus({ preventScroll: true });
    }
    const onPointer = (event: PointerEvent) => {
      if (layerOwns(event)) return;
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (layerOwns(event)) return;
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      if (closeCurrent === close) closeCurrent = null;
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      restoreSurfaceFocus(opener, surface);
    };
  }, [open, role]);
  if (!open) return null;
  return (
    <div ref={ref} role={surfaceRole} aria-label={label ?? (triggerLabel || "선택과 설정")} tabIndex={-1} className={`popover popover-${placement} popover-${align} ${fitWithinClippingAncestors ? "popover-fitted" : ""} ${className ?? ""}`}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (surfaceRole === "menu" && event.key === "Tab") { restoreSurfaceFocus(openerRef.current, ref.current); closeRef.current(); return; }
        if (surfaceRole === "menu" && moveMenuFocus(event.currentTarget, event.key)) { event.preventDefault(); event.stopPropagation(); }
        // Menu actions must not also answer an approval in the conversation behind them.
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}>
      <MenuContext.Provider value={surfaceRole === "menu"}>{children}</MenuContext.Provider>
    </div>
  );
}

export function MenuItem({
  children,
  hint,
  onSelect,
  active,
  disabled,
  disabledReason,
}: {
  children: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  active?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const isMenu = useContext(MenuContext);
  const reasonId = useId();
  return (
    <button type="button" role={isMenu ? active !== undefined ? "menuitemcheckbox" : "menuitem" : undefined}
      aria-checked={isMenu ? active : undefined} aria-pressed={!isMenu ? active : undefined}
      aria-disabled={disabled || undefined} aria-describedby={disabled ? reasonId : undefined}
      tabIndex={isMenu ? -1 : 0} data-menu-item="" data-menu-active={active || undefined}
      className={`menu-item${active ? " active" : ""}`} onClick={() => { if (!disabled) onSelect(); }}>
      <span className="menu-item-label">{children}{disabled ? <small className="menu-disabled-reason" id={reasonId}>{disabledReason ?? "지금은 사용할 수 없습니다."}</small> : null}</span>
      {hint ? <span className="menu-item-hint">{hint}</span> : null}
    </button>
  );
}
