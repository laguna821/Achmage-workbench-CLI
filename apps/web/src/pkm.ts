import type { PkmState, VaultFolder, VaultStatus, VaultTree } from "@workbench/contracts";
import type { Api } from "./api.ts";

// The PKM layer as the UI sees it: calls to `/api/pkm/*` and the vault tree as plain rows (kept
// free of React so it can be tested).

export function pkmClient(api: Api) {
  return {
    state: () => api.request<PkmState>("GET", "/api/pkm/state"),
    tree: () => api.request<VaultTree>("GET", "/api/pkm/vault/tree"),
    attach: (path: string) => api.request<VaultStatus>("PUT", "/api/pkm/vault", { path }),
    detach: () => api.request<VaultStatus>("DELETE", "/api/pkm/vault"),
    rescan: () => api.request<VaultStatus>("POST", "/api/pkm/vault/rescan"),
  };
}

export type PkmClient = ReturnType<typeof pkmClient>;

/** What the centre shows besides conversations and documents: cards of a vault folder, an app folder, a work or a saved view, or one vault note. */
export type PkmTarget =
  | { kind: "vault"; path: string }
  | { kind: "note"; path: string }
  | { kind: "folder"; id: string }
  | { kind: "work"; id: string }
  | { kind: "view"; id: string };

export type VaultRow = { folder: VaultFolder; depth: number; open: boolean; expandable: boolean };

/** Folders in display order: the vault's top folders, and the children of unfolded ones. */
export function vaultRows(root: VaultFolder | null, open: ReadonlySet<string>): VaultRow[] {
  const rows: VaultRow[] = [];
  const walk = (folder: VaultFolder, depth: number) => {
    const expandable = folder.children.length > 0;
    const isOpen = expandable && open.has(folder.path);
    rows.push({ folder, depth, open: isOpen, expandable });
    if (isOpen) for (const child of folder.children) walk(child, depth + 1);
  };
  for (const child of root?.children ?? []) walk(child, 0);
  return rows;
}

/**
 * Consecutive top-level folders of one border group share a single border (as the user's add-on
 * draws them); a folder of no group, or of another group, starts a new block.
 */
export function groupRuns<T extends { folder: VaultFolder }>(blocks: T[], groups: { id: string; folders: string[] }[]): { groupId: string | null; blocks: T[] }[] {
  const groupOf = (path: string) => groups.find((group) => group.folders.some((folder) => folder === path || path.startsWith(`${folder}/`)))?.id ?? null;
  const runs: { groupId: string | null; blocks: T[] }[] = [];
  for (const block of blocks) {
    const groupId = groupOf(block.folder.path);
    const last = runs.at(-1);
    if (last && groupId !== null && last.groupId === groupId) last.blocks.push(block);
    else runs.push({ groupId, blocks: [block] });
  }
  return runs;
}

/** "현재 · 하위" note counts of a folder row. */
export function countLabel(folder: Pick<VaultFolder, "own" | "below">) {
  if (!folder.own && !folder.below) return "";
  return folder.below ? `${folder.own} · ${folder.below}` : String(folder.own);
}

/** `obsidian://open?path=` for a vault file or folder (Obsidian finds the vault by the path). */
export const obsidianUrl = (vaultRoot: string, relativePath = "") => `obsidian://open?path=${encodeURIComponent(relativePath ? `${vaultRoot}/${relativePath}` : vaultRoot)}`;

const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Open an `obsidian://` link: the desktop opener in the app, the browser elsewhere. */
export async function openObsidian(url: string) {
  if (inDesktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}
