import { existsSync, readdirSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { BorderStyle, ThemedColor, VaultBorders, VaultFolder, VaultStatus, VaultTree } from "@workbench/contracts";

// The Obsidian vault as a read-only mirror: its folder tree with note counts, drawn the way the
// user's Notebook Navigator (colours, icons, pins, hidden folders) and border add-on (group and
// folder borders, per-theme colours) draw it. Nothing here writes into the vault; it is only read
// and watched. Of the vault's plugin settings only these two files are ever opened, and of them
// only the display keys are kept (other plugins keep credentials in theirs).

/** The only plugin settings files read from a vault. */
export const READ_PLUGIN_SETTINGS = ["notebook-navigator", "achmage-nn-border-addon"] as const;

/** Files listed as notes: what Notebook Navigator shows as supported documents. */
export const NOTE_EXTENSIONS = new Set([".md", ".canvas", ".base", ".pdf"]);
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp"]);

/** A big vault is still scanned, but never without bound. */
const MAX_ENTRIES = 60_000;

/** Where Obsidian keeps its own list of vaults (Linux, Flatpak, macOS, Windows). */
function obsidianRegistries() {
  const home = homedir();
  return [
    join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "obsidian", "obsidian.json"),
    join(home, ".var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json"),
    join(home, "Library/Application Support/obsidian/obsidian.json"),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, "obsidian", "obsidian.json")] : []),
  ];
}

/**
 * The vault to offer first: the one Obsidian has open (else last opened) in its own vault list on
 * this computer. Tests point this elsewhere with WORKBENCH_VAULT_SUGGEST.
 */
export function suggestedVault(): string | null {
  if (process.env.WORKBENCH_VAULT_SUGGEST !== undefined) {
    const path = process.env.WORKBENCH_VAULT_SUGGEST;
    return path && existsSync(join(path, ".obsidian")) ? path : null;
  }
  for (const file of obsidianRegistries()) {
    try {
      const vaults = Object.values(record(record(JSON.parse(readFileSync(file, "utf8"))).vaults)).map(record);
      const best = vaults
        .filter((vault) => typeof vault.path === "string" && existsSync(join(vault.path, ".obsidian")))
        .sort((a, b) => Number(Boolean(b.open)) - Number(Boolean(a.open)) || Number(b.ts ?? 0) - Number(a.ts ?? 0))[0];
      if (best) return best.path as string;
    } catch {
      // No vault list here.
    }
  }
  return null;
}

// ── settings of the two plugins (display keys only) ─────────────────────────────────────────

/** A CSS colour from a settings file, or null: hex or rgb()/hsl() only, so nothing else reaches a style. */
export function safeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(rgb|hsl)a?\([0-9.,%\s/+-]+\)$/i.test(color)) return color;
  return null;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
const colors = (value: unknown) => Object.fromEntries(Object.entries(record(value)).flatMap(([key, color]) => (safeColor(color) ? [[key, safeColor(color)!]] : [])));

export type NavigatorLook = {
  folderColors: Record<string, string>;
  folderBackgrounds: Record<string, string>;
  folderIcons: Record<string, string>;
  tagColors: Record<string, string>;
  pinned: string[];
  hiddenFolders: string[];
  hiddenFileNames: string[];
  shortcuts: { path: string; kind: "note" | "folder" }[];
  inheritColors: boolean;
};

export type BorderLook = {
  folderBorders: Record<string, BorderStyle>;
  groups: VaultBorders["groups"];
  colorOverrides: Record<string, { light: { color: string | null; background: string | null }; dark: { color: string | null; background: string | null } }>;
  showFolderBorders: boolean;
  showGroupBorders: boolean;
  showFolderColors: boolean;
  suppressNested: boolean;
};

function readSettings(root: string, plugin: (typeof READ_PLUGIN_SETTINGS)[number]): Record<string, unknown> | null {
  try {
    return record(JSON.parse(readFileSync(join(root, ".obsidian", "plugins", plugin, "data.json"), "utf8")));
  } catch {
    return null;
  }
}

/** Notebook Navigator's display settings: colours, icons, pins, hidden folders and shortcuts. */
export function readNavigator(root: string): NavigatorLook | null {
  const data = readSettings(root, "notebook-navigator");
  if (!data) return null;
  // Hidden folders and shortcuts live in the active profile (older versions keep them at the top).
  const profiles = Array.isArray(data.vaultProfiles) ? data.vaultProfiles.map(record) : [];
  const profile = profiles.find((entry) => entry.id === data.vaultProfile) ?? profiles[0] ?? data;
  const pinned = Object.entries(record(data.pinnedNotes))
    .filter(([, where]) => (typeof where === "object" ? record(where).folder !== false : Boolean(where)))
    .map(([path]) => path);
  return {
    folderColors: colors(data.folderColors),
    folderBackgrounds: colors(data.folderBackgroundColors),
    folderIcons: Object.fromEntries(Object.entries(record(data.folderIcons)).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    tagColors: Object.fromEntries(Object.entries(colors(data.tagColors)).map(([tag, color]) => [tag.toLowerCase(), color])),
    pinned,
    hiddenFolders: strings(profile.hiddenFolders ?? data.excludedFolders),
    hiddenFileNames: strings(profile.hiddenFileNames),
    shortcuts: (Array.isArray(profile.shortcuts) ? profile.shortcuts : []).map(record).flatMap((entry) =>
      typeof entry.path === "string" && (entry.type === "note" || entry.type === "folder") ? [{ path: entry.path, kind: entry.type }] : [],
    ),
    inheritColors: data.inheritFolderColors !== false,
  };
}

const themed = (light: unknown, dark: unknown): ThemedColor => ({ light: safeColor(light), dark: safeColor(dark) ?? safeColor(light) });

function borderStyle(raw: unknown): BorderStyle {
  const style = record(raw);
  return {
    start: themed(style.startColor, style.darkStartColor),
    // A dark start colour without a dark end draws a plain border in the dark theme, as the add-on does.
    end: { light: safeColor(style.endColor), dark: safeColor(style.darkStartColor) ? safeColor(style.darkEndColor) : safeColor(style.endColor) },
    radius: typeof style.radius === "number" && Number.isFinite(style.radius) ? Math.max(0, Math.min(24, style.radius)) : null,
  };
}

/** The border add-on's groups, folder borders and per-theme folder colours. */
export function readBorders(root: string): BorderLook | null {
  const data = readSettings(root, "achmage-nn-border-addon");
  if (!data) return null;
  const folderBorders = Object.fromEntries(Object.entries(record(data.folderBorders)).map(([path, style]) => [path, borderStyle(style)]));
  const groups = (Array.isArray(data.borderGroups) ? data.borderGroups : []).map(record).flatMap((group, index) =>
    strings(group.folders).length ? [{ id: typeof group.id === "string" ? group.id : `group-${index}`, name: typeof group.name === "string" ? group.name : `묶음 ${index + 1}`, folders: strings(group.folders), style: borderStyle(group.style) }] : [],
  );
  const side = (value: unknown) => ({ color: record(value).color === "none" ? "none" : safeColor(record(value).color), background: record(value).background === "none" ? "none" : safeColor(record(value).background) });
  const colorOverrides = Object.fromEntries(Object.entries(record(data.folderColorOverrides)).map(([path, value]) => [path, { light: side(record(value).light), dark: side(record(value).dark) }]));
  return {
    folderBorders,
    groups,
    colorOverrides,
    showFolderBorders: data.showFolderBorders !== false,
    showGroupBorders: data.showGroupBorders !== false,
    showFolderColors: data.showFolderColors !== false,
    suppressNested: data.suppressNestedBorders !== false,
  };
}

/** Notebook Navigator icon ids (`material-icons:email`, `lucide-book`, `book`) → icons the UI draws. */
const ICONS: Record<string, string> = {
  email: "mail", mail: "mail", inbox: "mail", "mark-email-read": "mail", "mail-open": "mail",
  info: "info", "info-outline": "info", help: "info", "help-outline": "info", "circle-help": "info",
  book: "book", "menu-book": "book", "book-open": "book", library: "book", "library-books": "book", "auto-stories": "book", school: "book", "graduation-cap": "book",
  "run-circle": "run", "directions-run": "run", run: "run", footprints: "run", activity: "run",
  star: "star", grade: "star", tag: "tag", label: "tag", lightbulb: "bulb", "tips-and-updates": "bulb", idea: "bulb",
  folder: "folder", "folder-open": "folderOpen", description: "file", file: "file", "file-text": "page", article: "page",
  archive: "archive", inventory: "archive", settings: "tool", cog: "tool", build: "tool", wrench: "tool",
  chat: "chat", forum: "chat", "message-square": "chat", pin: "pin", "push-pin": "pin", home: "home", search: "search",
  palette: "palette", brush: "palette", terminal: "terminal", code: "terminal", public: "globe", language: "globe", globe: "globe",
};

export function iconFor(id: string | undefined): string | null {
  if (!id) return null;
  const name = (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id).replace(/^lucide-/, "").replace(/_/g, "-").toLowerCase();
  return ICONS[name] ?? null;
}

// ── hidden folders (Notebook Navigator patterns) ───────────────────────────────────────────

const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`, "i");

/**
 * Whether a folder is hidden by Notebook Navigator's patterns: `/a/b*` matches a path from the
 * vault root, a plain name (wildcards allowed) matches a folder of that name anywhere.
 */
export function hiddenBy(patterns: string[], path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return patterns.some((raw) => {
    const pattern = raw.trim();
    if (!pattern) return false;
    if (pattern.startsWith("/")) {
      const rooted = pattern.replace(/^\/+|\/+$/g, "");
      return rooted ? wildcard(rooted).test(path) : false;
    }
    return wildcard(pattern).test(name);
  });
}

// ── scanning ───────────────────────────────────────────────────────────────────────────────

export type NoteEntry = { path: string; name: string; ext: string; mtime: number; ctime: number; size: number };
type FolderEntry = { path: string; name: string; parent: string | null; notes: string[]; children: string[] };

export type VaultIndex = {
  root: string;
  folders: Map<string, FolderEntry>;
  notes: Map<string, NoteEntry>;
  /** Image files by lower-case name, for `![[image.png]]` embeds (Obsidian resolves them by name). */
  images: Map<string, string>;
  /** Every image file (vault-relative), for `![](path)` links. */
  imagePaths: Set<string>;
  /** Folders hidden by Notebook Navigator (with everything below them). */
  hidden: Set<string>;
  /** A short fingerprint of what was found, to tell a real change from a touch. */
  signature: string;
};

/** Walk the vault: folders (no dot folders, no symlinks), notes and images. */
export function scanVault(root: string, navigator: NavigatorLook | null): VaultIndex {
  const folders = new Map<string, FolderEntry>();
  const notes = new Map<string, NoteEntry>();
  const images = new Map<string, string>();
  const imagePaths = new Set<string>();
  const hidden = new Set<string>();
  const hiddenNames = navigator?.hiddenFileNames ?? [];
  let seen = 0;
  let signature = 0;
  const mix = (text: string) => {
    for (let index = 0; index < text.length; index += 1) signature = (Math.imul(signature, 31) + text.charCodeAt(index)) | 0;
  };
  const walk = (dir: string, path: string, parent: string | null, hiddenAbove: boolean) => {
    const folder: FolderEntry = { path, name: path ? basename(dir) : basename(root), parent, notes: [], children: [] };
    folders.set(path, folder);
    if (hiddenAbove) hidden.add(path);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        folder.children.push(rel);
        walk(full, rel, path, hiddenAbove || hiddenBy(navigator?.hiddenFolders ?? [], rel));
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const ext = lower.slice(lower.lastIndexOf("."));
      if (IMAGE_EXTENSIONS.has(ext)) {
        if (!images.has(lower)) images.set(lower, rel);
        imagePaths.add(rel);
        continue;
      }
      if (!NOTE_EXTENSIONS.has(ext) || hiddenBy(hiddenNames, entry.name)) continue;
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      notes.set(rel, { path: rel, name: entry.name, ext, mtime: stats.mtimeMs, ctime: stats.birthtimeMs || stats.ctimeMs, size: stats.size });
      folder.notes.push(rel);
      mix(`${rel}:${Math.round(stats.mtimeMs)}:${stats.size};`);
    }
    mix(`[${path}]`);
  };
  walk(root, "", null, false);
  return { root, folders, notes, images, imagePaths, hidden, signature: `${folders.size}:${notes.size}:${signature}` };
}

// ── the tree the sidebar draws ─────────────────────────────────────────────────────────────

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : path ? "" : null);
const looks = (path: string) => (path === "" ? "/" : path);

/**
 * A folder's colour in one theme: the add-on's override for that theme, else Notebook Navigator's
 * colour, else (when colours are inherited) the parent folder's. "none" in an override means no colour.
 */
export function folderColor(path: string, theme: "light" | "dark", key: "color" | "background", navigator: NavigatorLook | null, borders: BorderLook | null): string | null {
  for (let at: string | null = path; at !== null; at = parentOf(at)) {
    const override = borders?.showFolderColors !== false ? borders?.colorOverrides[looks(at)]?.[theme]?.[key] : null;
    if (override === "none") return null;
    const own = override ?? (key === "color" ? navigator?.folderColors[looks(at)] : navigator?.folderBackgrounds[looks(at)]) ?? null;
    if (own) return own;
    if (navigator && !navigator.inheritColors) return null;
  }
  return null;
}

export function buildTree(index: VaultIndex, navigator: NavigatorLook | null, borders: BorderLook | null): VaultFolder | null {
  const pinned = new Set(navigator?.pinned ?? []);
  const build = (path: string): VaultFolder | null => {
    const folder = index.folders.get(path);
    if (!folder || (path && index.hidden.has(path))) return null;
    const children = folder.children
      .map(build)
      .filter((child): child is VaultFolder => child !== null)
      .sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true, sensitivity: "base" }));
    return {
      path,
      name: folder.name,
      own: folder.notes.length,
      below: children.reduce((sum, child) => sum + child.own + child.below, 0),
      color: { light: folderColor(path, "light", "color", navigator, borders), dark: folderColor(path, "dark", "color", navigator, borders) },
      background: { light: folderColor(path, "light", "background", navigator, borders), dark: folderColor(path, "dark", "background", navigator, borders) },
      icon: iconFor(navigator?.folderIcons[looks(path)]),
      pinned: folder.notes.filter((note) => pinned.has(note)).length,
      children,
    };
  };
  return build("");
}

export const noteTitle = (path: string) => (path.split("/").pop() ?? path).replace(/\.(md|canvas|base)$/i, "");

// ── the mirror ─────────────────────────────────────────────────────────────────────────────

export type VaultEvents = { changed: (version: number) => void };

/**
 * One attached vault: scanned on attach, kept current by watching its folders (debounced), and read
 * on demand. Every path from the UI is checked to stay inside the vault before anything is read.
 */
export class VaultMirror {
  private rootPath: string | null = null;
  private index: VaultIndex | null = null;
  private navigatorLook: NavigatorLook | null = null;
  private borderLook: BorderLook | null = null;
  private problemText: string | null = null;
  private versionNo = 0;
  private scannedAt: number | null = null;
  private readonly watchers = new Map<string, FSWatcher>();
  private debounce: NodeJS.Timeout | null = null;
  private readonly onChange: (version: number) => void;
  private readonly debounceMs: number;

  constructor(onChange: (version: number) => void, options: { debounceMs?: number } = {}) {
    this.onChange = onChange;
    this.debounceMs = options.debounceMs ?? 600;
  }

  get root() {
    return this.rootPath;
  }

  get version() {
    return this.versionNo;
  }

  get navigator() {
    return this.navigatorLook;
  }

  /** The current index (scanned on demand when the vault was attached but not read yet). */
  get current(): VaultIndex | null {
    return this.index;
  }

  /** Point the mirror at a vault folder (or at none). Throws a message for the user when it is not one. */
  attach(path: string | null) {
    this.stopWatching();
    this.rootPath = null;
    this.index = null;
    this.problemText = null;
    if (!path) {
      this.bump();
      return;
    }
    if (!isAbsolute(path)) throw new Error("볼트 경로는 절대 경로여야 합니다.");
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error("그 폴더가 없습니다.");
    if (!existsSync(join(path, ".obsidian"))) throw new Error("옵시디언 볼트가 아닙니다(.obsidian 폴더가 없습니다).");
    this.rootPath = realpathSync(path);
    this.rescan();
  }

  /** Remember a vault whose folder is gone for now (unplugged disk, Dropbox not synced yet). */
  restore(path: string) {
    try {
      this.attach(path);
    } catch (error) {
      this.rootPath = path;
      this.problemText = error instanceof Error ? error.message : String(error);
    }
  }

  status(): VaultStatus {
    return {
      path: this.rootPath,
      name: this.rootPath ? basename(this.rootPath) : null,
      problem: this.problemText,
      suggested: this.rootPath ? null : suggestedVault(),
      notes: this.index ? [...this.index.notes.keys()].filter((path) => !this.isHidden(path)).length : 0,
      folders: this.index ? [...this.index.folders.keys()].filter((path) => path && !this.index!.hidden.has(path)).length : 0,
      navigator: Boolean(this.navigatorLook),
      borders: Boolean(this.borderLook),
      version: this.versionNo,
      scannedAt: this.scannedAt,
    };
  }

  /** A note or folder path inside a hidden folder (Notebook Navigator). */
  isHidden(path: string) {
    const folder = parentOf(path);
    return folder !== null && folder !== "" && Boolean(this.index?.hidden.has(folder));
  }

  tree(): VaultTree {
    const status = this.status();
    if (!this.index) return { status, root: null, borders: null, pinned: [], shortcuts: [], tagColors: {} };
    const navigator = this.navigatorLook;
    const borders = this.borderLook;
    return {
      status,
      root: buildTree(this.index, navigator, borders),
      borders: borders
        ? { groups: borders.groups, folders: borders.folderBorders, showGroups: borders.showGroupBorders, showFolders: borders.showFolderBorders, suppressNested: borders.suppressNested }
        : null,
      pinned: (navigator?.pinned ?? []).filter((path) => this.index!.notes.has(path)).map((path) => ({ path, title: noteTitle(path) })),
      shortcuts: (navigator?.shortcuts ?? [])
        .filter((entry) => (entry.kind === "note" ? this.index!.notes.has(entry.path) : this.index!.folders.has(entry.path)))
        .map((entry) => ({ ...entry, title: entry.kind === "note" ? noteTitle(entry.path) : (entry.path.split("/").pop() ?? entry.path) })),
      tagColors: navigator?.tagColors ?? {},
    };
  }

  /**
   * The absolute path of something inside the vault, or an error: never outside it (no `..`, no
   * symlink leading elsewhere) and never in its dot folders (`.obsidian`, `.trash`…).
   */
  resolve(relativePath: string): string {
    if (!this.rootPath) throw new Error("연결된 볼트가 없습니다.");
    const clean = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean || clean.split("/").some((part) => part === ".." || part.startsWith("."))) throw new Error("볼트 밖이나 숨은 폴더의 경로입니다.");
    const full = resolve(this.rootPath, clean);
    const inside = relative(this.rootPath, full);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("볼트 밖의 경로입니다.");
    if (existsSync(full)) {
      const real = realpathSync(full);
      const realInside = relative(this.rootPath, real);
      if (realInside.startsWith("..") || isAbsolute(realInside)) throw new Error("볼트 밖을 가리키는 링크입니다.");
    }
    return full;
  }

  /** Read the settings and walk the vault again; tell listeners only when something changed. */
  rescan(force = false) {
    const root = this.rootPath;
    if (!root) return;
    if (!existsSync(root)) {
      this.problemText = "볼트 폴더를 찾지 못했습니다.";
      this.index = null;
      this.bump();
      return;
    }
    this.navigatorLook = readNavigator(root);
    this.borderLook = readBorders(root);
    const next = scanVault(root, this.navigatorLook);
    const changed = force || !this.index || this.index.signature !== next.signature || this.problemText !== null;
    this.index = next;
    this.problemText = null;
    this.scannedAt = Date.now();
    this.syncWatchers();
    if (changed) this.bump();
  }

  private bump() {
    this.versionNo += 1;
    this.onChange(this.versionNo);
  }

  /** Settings files that changed make colours, pins and hidden folders count as a change even if no note moved. */
  private settingsPending = false;

  private schedule(settings: boolean) {
    this.settingsPending ||= settings;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const force = this.settingsPending;
      this.settingsPending = false;
      this.rescan(force);
    }, this.debounceMs);
    this.debounce.unref?.();
  }

  /** One watcher per shown folder (Linux has no cheap recursive watch); the plugin folders for settings. */
  private syncWatchers() {
    const root = this.rootPath;
    if (!root || !this.index) return;
    const wanted = new Map<string, boolean>();
    for (const path of this.index.folders.keys()) if (!this.index.hidden.has(path)) wanted.set(join(root, path), false);
    for (const plugin of READ_PLUGIN_SETTINGS) {
      const dir = join(root, ".obsidian", "plugins", plugin);
      if (existsSync(dir)) wanted.set(dir, true);
    }
    for (const [dir, watcher] of this.watchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
    for (const [dir, settings] of wanted) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, (_event, file) => {
          if (settings && file !== "data.json") return;
          this.schedule(settings);
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(dir);
          this.schedule(false);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // A folder that vanished between the scan and here: the next scan settles it.
      }
    }
  }

  private stopWatching() {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.settingsPending = false;
  }

  close() {
    this.stopWatching();
  }
}
