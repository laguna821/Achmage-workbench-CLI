import type { Artifact, CardList, InsightDraft, PageTemplate, PkmCard, PkmRule, PkmState, PkmView, RuleChange, SendResult, VaultFolder, VaultNote, VaultStatus, VaultTree } from "@workbench/contracts";
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
    cards: (target: Exclude<PkmTarget, { kind: "note" }>, descendants = true) => {
      const params = new URLSearchParams({ kind: target.kind });
      if (target.kind === "vault") {
        params.set("path", target.path);
        params.set("descendants", descendants ? "1" : "0");
      } else params.set("id", target.id);
      return api.request<CardList>("GET", `/api/pkm/cards?${params}`);
    },
    note: (path: string) => api.request<VaultNote>("GET", `/api/pkm/vault/note?${new URLSearchParams({ path })}`),
    insight: (sessionId: string) => api.request<InsightDraft>("GET", `/api/pkm/insight?${new URLSearchParams({ sessionId })}`),
    checkInsight: (sessionId: string, text: string) => api.request<{ problems: string[] }>("POST", "/api/pkm/insight/check", { sessionId, text }),
    publishInsight: (sessionId: string, text: string, requestId: string) =>
      api.request<SendResult & { requestId: string }>("POST", "/api/pkm/insight/publish", { sessionId, text, requestId }),
    pin: (workId: string, path: string, pinned: boolean) => api.request<string[]>("PUT", "/api/pkm/pins", { workId, path, pinned }),
    contextCard: (workId: string) => api.request<{ card: string; protected: string[] }>("GET", `/api/pkm/context-card?${new URLSearchParams({ workId })}`),
    saveView: (view: Partial<PkmView>) => api.request<PkmView>("PUT", "/api/pkm/views", view),
    deleteView: (id: string) => api.request<{ ok: boolean }>("DELETE", `/api/pkm/views/${encodeURIComponent(id)}`),
    previewView: (query: string, groupBy: string | null) => api.request<CardList>("POST", "/api/pkm/views/preview", { query, groupBy }),
    saveRules: (rules: PkmRule[]) => api.request<PkmRule[]>("PUT", "/api/pkm/rules", { rules }),
    previewRules: () => api.request<RuleChange[]>("GET", "/api/pkm/rules/preview"),
    applyRules: (workIds: string[]) => api.request<{ applied: number }>("POST", "/api/pkm/rules/apply", { workIds }),
    templates: (workId: string) => api.request<PageTemplate[]>("GET", `/api/pkm/templates?${new URLSearchParams({ workId })}`),
    pageFromTemplate: (request: { workId: string; templateId: string; title: string; choices: Record<string, string[]>; parentId: string | null }) =>
      api.request<Artifact>("POST", "/api/pkm/pages/from-template", request),
    subpage: (parentId: string, name: string) => api.request<Artifact>("POST", "/api/pkm/pages/subpage", { parentId, name }),
    sessionPage: (sessionId: string, workId: string) => api.request<Artifact>("POST", "/api/pkm/pages/from-session", { sessionId, workId }),
    messagePage: (sessionId: string, itemId: string, selection: string | null) => api.request<Artifact>("POST", "/api/pkm/pages/from-message", { sessionId, itemId, selection }),
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
  // Only the gateway's own pictures are fetched with its token; nothing else gets the token.
  if (!path.startsWith("/api/")) return Promise.resolve(null);
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
  !thumb
    ? null
    : "url" in thumb
      ? thumb.url
      : "vault" in thumb
        ? vaultImagePath(thumb.vault, version)
        : `/api/pkm/page-image?${new URLSearchParams({ artifact: thumb.page, src: thumb.src })}`;

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
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const noteHref = (path: string) => encodeURIComponent(path).replace(/[()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`);

/**
 * A vault note's text for the Markdown view: pictures (`![[그림.png|300]]`, `![](상대 경로)`,
 * `<img src>`) point at the gateway (the size stays after `|` in the text), `[[links]]` open notes
 * here, `![[another note]]` becomes a `vault-embed:` link the view draws in place, and `%%comments%%`
 * go. Callouts, highlights and tags are left to the Markdown view.
 */
export function vaultMarkdown(body: string, note: Pick<VaultNote, "links" | "embeds">, version = 0) {
  const image = (target: string, alt: string) => {
    const path = note.embeds[target.trim()];
    return path ? `![${alt.replace(/[[\]]/g, "")}](${vaultImagePath(path, version).replace(/ /g, "%20")})` : `*(그림 없음: ${target.trim()})*`;
  };
  return body
    .replace(/%%[\s\S]*?%%/g, "")
    // Both picture forms in one pass, so a picture already rewritten is never taken up again.
    .replace(
      /!\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]|!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g,
      (all, embed: string | undefined, heading: string | undefined, alias: string | undefined, alt: string | undefined, target: string | undefined) => {
        if (embed === undefined) return /^[a-z]+:/i.test(target ?? "") ? all : image(target ?? "", alt ?? "");
        const name = embed.trim();
        const label = alias?.trim() ?? "";
        if (IMAGE_NAME.test(name)) return image(name, !label ? name : /^\d+(x\d+)?$/.test(label) ? `${name}|${label}` : label);
        const path = note.links[name];
        if (!path) return `*(노트 없음: ${name})*`;
        return `[${(label || name).replace(/[[\]]/g, "")}](vault-embed:${noteHref(path)}${heading && heading.length > 1 ? `#${encodeURIComponent(heading.slice(1))}` : ""})`;
      },
    )
    .replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (all, head: string, quote: string, src: string) => {
      const path = /^[a-z]+:/i.test(src) ? null : note.embeds[src.trim()];
      return path ? `${head}${quote}${vaultImagePath(path, version)}${quote}` : all;
    })
    .replace(/(?<!!)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_all, target: string, _heading: string | undefined, alias: string | undefined) => {
      const path = note.links[target.trim()];
      const label = (alias ?? target).trim().replace(/[[\]]/g, "");
      return path ? `[${label}](vault-note:${noteHref(path)})` : `${label}`;
    });
}

/**
 * The part of a note `![[note#제목]]` or `![[note#^id]]` points at: the heading with what is under
 * it (up to the next heading as high), or the line carrying the block id. The whole note otherwise.
 */
export function noteSection(body: string, ref: string | null): string {
  if (!ref) return body;
  const lines = body.split("\n");
  if (ref.startsWith("^")) {
    const id = ref.slice(1);
    const line = lines.find((entry) => entry.trimEnd().endsWith(` ^${id}`));
    return line ? line.trimEnd().slice(0, -(id.length + 2)) : "";
  }
  const wanted = ref.split("#").pop()!.trim().toLowerCase();
  let start = -1;
  let level = 0;
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    if (start < 0) {
      if (heading[2]!.trim().toLowerCase() === wanted) {
        start = index;
        level = heading[1]!.length;
      }
    } else if (heading[1]!.length <= level) return lines.slice(start, index).join("\n");
  }
  return start < 0 ? "" : lines.slice(start).join("\n");
}
