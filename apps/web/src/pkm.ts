import type { CardList, PkmCard, PkmState, SendResult, VaultFolder, VaultNote, VaultStatus, VaultTree } from "@workbench/contracts";
import { readToken, type Api } from "./api.ts";

// The PKM layer as the UI sees it: calls to `/api/pkm/*` and the vault tree as plain rows (kept
// free of React so it can be tested).

export function pkmClient(api: Api) {
  return {
    state: () => api.request<PkmState>("GET", "/api/pkm/state"),
    tree: () => api.request<VaultTree>("GET", "/api/pkm/vault/tree"),
    attach: (path: string) => api.request<VaultStatus>("PUT", "/api/pkm/vault", { path }),
    detach: () => api.request<VaultStatus>("DELETE", "/api/pkm/vault"),
    rescan: () => api.request<VaultStatus>("POST", "/api/pkm/vault/rescan"),
    cards: (target: Exclude<PkmTarget, { kind: "note" } | { kind: "view" }>, descendants = true) => {
      const params = new URLSearchParams({ kind: target.kind });
      if (target.kind === "vault") {
        params.set("path", target.path);
        params.set("descendants", descendants ? "1" : "0");
      } else params.set("id", target.id);
      return api.request<CardList>("GET", `/api/pkm/cards?${params}`);
    },
    note: (path: string) => api.request<VaultNote>("GET", `/api/pkm/vault/note?${new URLSearchParams({ path })}`),
    /** A request with vault notes attached as read-only references. */
    send: (sessionId: string, requestId: string, text: string, notes: string[]) =>
      api.request<SendResult>("POST", `/api/sessions/${sessionId}/messages`, { requestId, text, notes }),
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

// ── pictures (fetched with the token, shown as object URLs) ─────────────────────────────────

const pictures = new Map<string, Promise<string | null>>();

/** An image the gateway serves behind the token, as an object URL (kept for the window's life, at most 300). */
export function pictureUrl(path: string): Promise<string | null> {
  const cached = pictures.get(path);
  if (cached) return cached;
  const token = readToken();
  const loading = fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
    .then((response) => (response.ok ? response.blob() : null))
    .then((blob) => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => null);
  pictures.set(path, loading);
  if (pictures.size > 300) {
    const oldest = pictures.keys().next().value!;
    void pictures.get(oldest)?.then((url) => url && URL.revokeObjectURL(url));
    pictures.delete(oldest);
  }
  return loading;
}

export const vaultImagePath = (path: string, version = 0) => `/api/pkm/vault/image?${new URLSearchParams({ path, v: String(version) })}`;
export const thumbPath = (thumb: PkmCard["thumb"], version = 0) =>
  !thumb ? null : "vault" in thumb ? vaultImagePath(thumb.vault, version) : `/api/pkm/page-image?${new URLSearchParams({ artifact: thumb.page, src: thumb.src })}`;

// ── cards ───────────────────────────────────────────────────────────────────────────────────

/** Date groups as Notebook Navigator shows them: pinned, today, yesterday, last 7 / 30 days, then months. */
export function dateGroup(card: Pick<PkmCard, "pinned" | "date">, now = Date.now()): string {
  if (card.pinned) return "고정";
  if (!card.date) return "날짜 없음";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (card.date >= start.getTime()) return "오늘";
  if (card.date >= start.getTime() - day) return "어제";
  if (card.date >= start.getTime() - 6 * day) return "지난 7일";
  if (card.date >= start.getTime() - 29 * day) return "지난 30일";
  const date = new Date(card.date);
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
}

/** Cards in their order, cut into date groups. */
export function groupCards<T extends Pick<PkmCard, "pinned" | "date">>(cards: T[], now = Date.now()): { label: string; cards: T[] }[] {
  const groups: { label: string; cards: T[] }[] = [];
  for (const card of cards) {
    const label = dateGroup(card, now);
    const last = groups.at(-1);
    if (last?.label === label) last.cards.push(card);
    else groups.push({ label, cards: [card] });
  }
  return groups;
}

/** Card date: "2026. 10. 22." style, the time for today. */
export function cardDate(at: number | null, now = Date.now()) {
  if (!at) return "";
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString("ko-KR", { year: date.getFullYear() === today.getFullYear() ? undefined : "numeric", month: "short", day: "numeric" });
}

/**
 * Obsidian Markdown for the read-only view: `![[pic]]` and `![](pic)` become images the gateway
 * serves, `[[note|alias]]` becomes a link that opens the note in the mirror (plain text when it does
 * not exist), `%% comments %%` disappear and callout markers become a bold label.
 */
export function vaultMarkdown(body: string, note: Pick<VaultNote, "links" | "embeds">, version = 0) {
  const image = (target: string, alt: string) => {
    const path = note.embeds[target.trim()];
    return path ? `![${alt.replace(/[[\]]/g, "")}](${vaultImagePath(path, version).replace(/ /g, "%20")})` : `*(그림 없음: ${target.trim()})*`;
  };
  return body
    .replace(/%%[\s\S]*?%%/g, "")
    // Both picture forms in one pass, so a picture already rewritten is never taken up again.
    .replace(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g, (all, embed: string | undefined, alt: string | undefined, target: string | undefined) =>
      embed !== undefined ? image(embed, embed) : /^[a-z]+:/i.test(target ?? "") ? all : image(target ?? "", alt ?? ""),
    )
    .replace(/(?<!!)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_all, target: string, _heading: string | undefined, alias: string | undefined) => {
      const path = note.links[target.trim()];
      const label = (alias ?? target).trim().replace(/[[\]]/g, "");
      return path ? `[${label}](vault-note:${encodeURIComponent(path).replace(/[()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)})` : `${label}`;
    })
    .replace(/^(\s*>\s*)\[!([^\]]+)\][+-]?\s*/gm, (_all, quote: string, kind: string) => `${quote}**${kind}** `);
}
