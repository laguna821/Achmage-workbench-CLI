// The sidebar as a two-pane navigator, shaped like Obsidian's Notebook Navigator: project folders on
// the left (navigation pane), the projects of what is selected on the right (list pane). Folders
// are the gateway's; everything else here is a screen preference the UI keeps in `/api/prefs`.

/** "폴더만 지우기" (`DELETE /api/folders/:id`): what moved up to the folder's parent. */
export type DeleteFolderResult = { parentId: string | null; folders: string[]; works: string[] };

/** Navigation | list side by side ("두 칸"), stacked ("위아래"), or the single tree ("한 칸"). */
export type NavLayout = "dual" | "stacked" | "tree";

/** What the list is ordered by: last activity, creation, name, the "마감일" property, the stage. */
export type NavSortKey = "activity" | "created" | "name" | "due" | "stage";
export type NavSort = { key: NavSortKey; desc: boolean };

/** What the navigation pane has selected: the "프로젝트" root, a folder, a tag (with those under it) or "태그 없음". */
export type NavSelection = { kind: "root" } | { kind: "folder"; id: string } | { kind: "tag"; tag: string } | { kind: "untagged" };

/** Section heads of the navigation pane that fold (the vault keeps its own fold). */
export type NavSectionId = "now" | "shortcuts" | "projects" | "tags" | "views";

/** prefs `navigator`: one object, every field optional (missing ones take the defaults). */
export type NavigatorPrefs = {
  /** Absent: two panes on a wide window, stacked on a narrow one. */
  layout?: NavLayout;
  navWidth?: number;
  listWidth?: number;
  /** Stacked: the navigation pane's share of the height (0.15–0.8). */
  navHeight?: number;
  selected?: NavSelection;
  sortDefault?: NavSort;
  /** Per selection ("root", a folder id, "tag:<name>", "untagged"), as Notebook Navigator sorts per folder. */
  sortByFolder?: Record<string, NavSort>;
  /** "하위 포함": projects of subfolders too (Notebook Navigator's "notes from subfolders"). */
  includeSub?: boolean;
  density?: "standard" | "compact";
  previewLines?: 0 | 1 | 2 | 3;
  /** With "하위 포함": group by folder or by date. */
  groupSub?: "folder" | "date";
  /** Folded sections (true = folded). */
  sections?: Partial<Record<NavSectionId, boolean>>;
  /** Tags unfolded in the tag tree. */
  openTags?: string[];
};

/**
 * prefs `navShortcuts` ("바로가기"; the key `shortcuts` is the keyboard's): projects, folders, tags,
 * saved views and sessions, in the person's order. `label` renames the shortcut only.
 */
export type NavShortcut = { kind: "work" | "folder" | "tag" | "view" | "session"; id: string; label?: string };
