import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { moveMenuFocus, restoreSurfaceFocus } from "./controls/menu-navigation.ts";

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
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
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
    <div ref={ref} role={surfaceRole} aria-label={label ?? (triggerLabel || "선택과 설정")} tabIndex={-1} className={`popover popover-${placement} popover-${align} ${className ?? ""}`}
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
