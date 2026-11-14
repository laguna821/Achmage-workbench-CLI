import { useEffect, useId, useState } from "react";
import type { MenuEntry, MenuRequest } from "../ContextMenu.tsx";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui/Menu.tsx";
import type { LayerAnchor } from "../ui/AnchoredLayer.tsx";
import { markMenuOrigin, rowOfAnchor } from "./focus.ts";

// A sidebar row's menu (documents) on the shared Menu: the same entries the app builds for a row,
// opened at the pointer (right-click) or under the row's ⋯.

/** No separator at either end or twice in a row. */
function tidy(items: MenuEntry[]) {
  const out: MenuEntry[] = [];
  for (const entry of items) {
    if (entry.kind === "separator" && (!out.length || out.at(-1)!.kind === "separator")) continue;
    out.push(entry);
  }
  while (out.at(-1)?.kind === "separator") out.pop();
  return out;
}

export function RowMenu({ request, anchor, onClose, side, onBack, origin }: {
  request: MenuRequest; anchor: LayerAnchor; onClose: () => void; side?: "right";
  /** A submenu: ← closes it and hands the keys back to the menu it opened from. */
  onBack?: () => void;
  /** The row this menu (or the menu above it) was opened for: where a dialog it opens returns the focus. */
  origin?: HTMLElement | null;
}) {
  // A submenu opens beside its item (Enter, →, click); choosing in it closes this menu too.
  const [sub, setSub] = useState<{ index: number; element: HTMLElement } | null>(null);
  const items = tidy(request.items);
  const opened = sub ? items[sub.index] : undefined;
  const own = `row-menu-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [from] = useState(() => origin ?? rowOfAnchor(anchor && "current" in anchor ? anchor.current : anchor));
  // → on the active item opens its submenu; ← in a submenu closes it. Only for keys typed in this menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
      const layer = document.querySelector<HTMLElement>(`.${own}`);
      if (!layer || !layer.contains(event.target as Node)) return;
      if (event.key === "ArrowLeft") {
        if (!onBack) return;
        event.preventDefault(); event.stopPropagation();
        onBack();
        return;
      }
      const activeId = layer.querySelector("[aria-activedescendant]")?.getAttribute("aria-activedescendant");
      const item = activeId ? document.getElementById(activeId) : null;
      if (!item?.dataset.value?.startsWith("submenu-") || item.getAttribute("aria-disabled") === "true") return;
      event.preventDefault(); event.stopPropagation();
      item.click();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [own, onBack]);
  // At the pointer it opens to the right of it; under the ⋯ it lines up with the button's end.
  return (
    <>
    <Menu open anchor={anchor} onClose={onClose} label={request.title ?? "메뉴"} side={side} align={side ? "start" : anchor && "x" in anchor ? "start" : "end"} className={`row-menu ${own}`}>
      {request.title ? <MenuLabel>{request.title}</MenuLabel> : null}
      {items.map((entry, index) =>
        entry.kind === "separator" ? <MenuSeparator key={`s${index}`} />
        : entry.kind === "label" ? <MenuLabel key={`l${index}`}>{entry.label}</MenuLabel>
        : entry.kind === "item" ? (
          <MenuItem key={`${index}:${entry.label}`} icon={entry.icon} hint={entry.hint} danger={entry.danger} disabled={entry.disabled} disabledReason={entry.disabledReason} checked={entry.checked} onSelect={() => { markMenuOrigin(from); entry.onSelect(); }}>
            {entry.label}
          </MenuItem>
        ) : entry.kind === "submenu" ? (
          <MenuItem key={`${index}:${entry.label}`} icon={entry.icon} more keepOpen disabled={entry.disabled} disabledReason={entry.disabledReason} value={`submenu-${index}`}
            onSelect={() => {
              const element = document.querySelector<HTMLElement>(`.${own} [data-value="submenu-${index}"]`);
              if (element) setSub({ index, element });
            }}>
            {entry.label}
          </MenuItem>
        ) : null,
      )}
    </Menu>
    {sub && opened?.kind === "submenu" ? (
      <RowMenu request={{ x: 0, y: 0, title: opened.label, items: opened.items }} anchor={sub.element} side="right" origin={from} onBack={() => setSub(null)}
        onClose={(reason?: string) => { setSub(null); if (reason === "select") onClose(); }} />
    ) : null}
    </>
  );
}
