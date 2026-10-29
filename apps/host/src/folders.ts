import type { Folder, Work } from "@workbench/contracts";

// Project folders as the navigator handles them: deleting one without losing what is inside
// ("폴더만 지우기"), and the colour and icon a person gives a folder. Pure, so it can be tested.

/**
 * What changes when a folder goes and its contents move up: its subfolders take its place among
 * the parent's folders (in their own order), its projects (archived ones too) keep their order keys
 * in the parent. Nothing is archived; the folder itself is left for the caller to delete.
 */
export function liftOut(folders: Folder[], works: Work[], folderId: string): { parentId: string | null; folders: Folder[]; works: Work[] } {
  const folder = folders.find((entry) => entry.id === folderId);
  if (!folder) return { parentId: null, folders: [], works: [] };
  // A parent that no longer exists counts as the top, as the tree shows it.
  const parentId = folder.parentId && folders.some((entry) => entry.id === folder.parentId) ? folder.parentId : null;
  const children = folders.filter((entry) => entry.parentId === folderId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ko"));
  const siblings = folders.filter((entry) => entry.id !== folderId && (entry.parentId ?? null) === parentId);
  const before = siblings.filter((entry) => entry.sort <= folder.sort).reduce<number | undefined>((max, entry) => (max === undefined || entry.sort > max ? entry.sort : max), undefined);
  const after = siblings.filter((entry) => entry.sort > folder.sort).reduce<number | undefined>((min, entry) => (min === undefined || entry.sort < min ? entry.sort : min), undefined);
  const low = before ?? folder.sort - 1;
  const high = after ?? folder.sort + 1;
  const moved = children.map((child, index) => ({ ...child, parentId, sort: low + ((high - low) * (index + 1)) / (children.length + 1) }));
  const lifted = works.filter((work) => work.folderId === folderId).map((work) => ({ ...work, folderId: parentId }));
  return { parentId, folders: moved, works: lifted };
}

/** A folder colour as given: `#rrggbb` (any case, `#rgb` widened), null to clear; anything else is refused. */
export function folderColor(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : undefined;
}

/** A folder icon as given: an icon name (letters only, as the app's icon set names them), null to clear. */
export function folderIcon(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  return typeof value === "string" && /^[A-Za-z]{1,32}$/.test(value) ? value : undefined;
}
