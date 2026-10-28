// Notion-like organisation with an Obsidian vault mirror (design 워크스테이션-다음설계 §4).
// The vault is read only for Workbench: it is scanned and drawn, never written.

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

/** What the UI shows of the PKM layer; fetched again when a `pkm.changed` event arrives. */
export type PkmState = {
  vault: VaultStatus;
};

/** Gateway scopes a `pkm.changed` event names. */
export type PkmScope = "vault" | "views" | "rules" | "pins" | "insights";
