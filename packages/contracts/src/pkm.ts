// Notion-like organisation with an Obsidian vault mirror (design 워크스테이션-다음설계 §4).
// The vault is read only for Workbench: it is scanned and drawn, never written.

import type { DocFormat, Provider, SessionStatus } from "./index.ts";

/** A colour per app theme, as the vault's Notebook Navigator and the user's border add-on give it. */
export type ThemedColor = { light: string | null; dark: string | null };

/** A gradient border (border add-on): start → end, with dark-theme colours when set. */
export type BorderStyle = { start: ThemedColor; end: ThemedColor; radius: number | null };

/** One folder of the vault mirror; `path` is relative to the vault ("" is the vault itself). */
export type VaultFolder = {
  path: string;
  name: string;
  /** Notes directly inside. */
  own: number;
  /** Notes in the folders below (not counting `own`). */
  below: number;
  color: ThemedColor;
  background: ThemedColor;
  /** An icon name the UI knows (mapped from Notebook Navigator's icon ids), or null. */
  icon: string | null;
  /** Pinned notes (Notebook Navigator) inside this folder. */
  pinned: number;
  children: VaultFolder[];
};

/** Group and folder borders as the border add-on draws them, already resolved per theme. */
export type VaultBorders = {
  groups: { id: string; name: string; folders: string[]; style: BorderStyle }[];
  folders: Record<string, BorderStyle>;
  showGroups: boolean;
  showFolders: boolean;
  suppressNested: boolean;
};

export type VaultStatus = {
  /** The attached vault folder, or null. */
  path: string | null;
  name: string | null;
  /** Why the vault cannot be shown (missing folder…), or null. */
  problem: string | null;
  /** A vault folder found on this computer, offered when none is attached. */
  suggested: string | null;
  notes: number;
  folders: number;
  /** Notebook Navigator settings were read (colours, icons, pins, hidden folders). */
  navigator: boolean;
  /** The border add-on's settings were read. */
  borders: boolean;
  /** Bumped on every change seen in the vault. */
  version: number;
  scannedAt: number | null;
};

export type VaultTree = {
  status: VaultStatus;
  root: VaultFolder | null;
  borders: VaultBorders | null;
  /** Notes pinned in Notebook Navigator (vault-relative paths), and its shortcuts. */
  pinned: { path: string; title: string }[];
  shortcuts: { path: string; title: string; kind: "note" | "folder" }[];
  /** Tag colours from Notebook Navigator (lower-case tag → colour). */
  tagColors: Record<string, string>;
};

/** One card of a card list (Notebook Navigator style): a vault note, a page, a session or a work. */
export type PkmCard = {
  kind: "note" | "page" | "session" | "work";
  /** Note: vault-relative path; page: artifact id; session / work: their id. */
  id: string;
  title: string;
  /** The first lines after the front matter (notes, pages) or the latest reply (sessions, works). */
  excerpt: string;
  tags: string[];
  date: number | null;
  /** created: the note's "date created"; modified: the file's time; activity: the last reply or change. */
  dateKind: "created" | "modified" | "activity";
  /** The first picture: a vault image (vault-relative path) or an image next to a page. */
  thumb: { vault: string } | { page: string; src: string } | null;
  /** Pinned in Notebook Navigator (notes) or in the sidebar (works, sessions). */
  pinned: boolean;
  /** The DIKM stage written in the note (`DIKM_단계:`), when there is one. */
  stage: string | null;
  provider?: Provider;
  status?: SessionStatus;
  format?: DocFormat;
  workId?: string;
  /** Sessions given this note (notes); sessions of the work (works). */
  sessions?: number;
  /** Where it is, for the line under the title (a note's folder, a session's work). */
  where?: string;
};

export type CardList = {
  title: string;
  crumbs: string[];
  cards: PkmCard[];
  /** Cards that matched before the list was cut short. */
  total: number;
  /** Vault folders: notes of subfolders are included. */
  descendants?: boolean;
};

/** A vault note opened read-only. */
export type VaultNote = {
  path: string;
  absolutePath: string;
  title: string;
  /** The text after the front matter. */
  body: string;
  /** Front matter keys exactly as spelled, with their values. */
  properties: [string, string[] | null][];
  tags: string[];
  date: number | null;
  /** `[[link]]` targets → vault paths (null when no such note). */
  links: Record<string, string | null>;
  /** `![[embed]]` and `![](path)` images → vault-relative image paths (null when missing). */
  embeds: Record<string, string | null>;
  /** Sessions this note was given to. */
  sessions: number;
};

/** What the UI shows of the PKM layer; fetched again when a `pkm.changed` event arrives. */
export type PkmState = {
  vault: VaultStatus;
};

/** Gateway scopes a `pkm.changed` event names. */
export type PkmScope = "vault" | "views" | "rules" | "pins" | "insights";
