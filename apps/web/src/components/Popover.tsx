import { useEffect, useRef, type ReactNode } from "react";

// One popover at a time (design rule): opening a new one replaces the current one.
let closeCurrent: (() => void) | null = null;

export function Popover({
  open,
  onClose,
  children,
  align = "left",
  placement = "below",
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right" | "center";
  placement?: "below" | "above";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    if (closeCurrent && closeCurrent !== onClose) closeCurrent();
    closeCurrent = onClose;
    const onPointer = (event: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      if (closeCurrent === onClose) closeCurrent = null;
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} role="menu" className={`popover popover-${placement} popover-${align} ${className ?? ""}`}>
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  hint,
  onSelect,
  active,
  disabled,
}: {
  children: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" role="menuitem" className={`menu-item${active ? " active" : ""}`} onClick={onSelect} disabled={disabled}>
      <span className="menu-item-label">{children}</span>
      {hint ? <span className="menu-item-hint">{hint}</span> : null}
    </button>
  );
}
