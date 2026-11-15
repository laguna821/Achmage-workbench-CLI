import type { MenuEntry } from "../ContextMenu.tsx";

/**
 * The owner (2026-11-14): a row's menu starts with 이름 바꾸기 where the item can be renamed, then the
 * row's other items as they were (a separator after it; no doubled separators left behind). A menu
 * without that item (a document: no rename) is returned as it is.
 */
export function renameFirst(items: MenuEntry[]): MenuEntry[] {
  const at = items.findIndex((entry) => entry.kind === "item" && entry.label === "이름 바꾸기");
  if (at <= 0) return items;
  const rest = [...items.slice(0, at), ...items.slice(at + 1)].filter((entry, index, list) => !(entry.kind === "separator" && (index === 0 || list[index - 1]?.kind === "separator" || index === list.length - 1)));
  return [items[at]!, { kind: "separator" }, ...rest];
}
