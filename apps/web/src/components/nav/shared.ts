import type { PointerEvent as ReactPointerEvent } from "react";
import type { Artifact, DocumentRemovalPlan, Folder, NavigatorPrefs, NavLayout, NavSelection, NavShortcut, ProjectStage, ProjectSummary, Provider, Session, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import type { Look } from "../../appearance.ts";
import type { State } from "../../state.ts";
import type { Move, Row, SortMode, TreeOpenState } from "../../tree.ts";
import type { MenuRequest } from "../ContextMenu.tsx";
import type { PaneItem } from "../../panes.ts";
import type { DragPayload } from "./drag.ts";
import type { ListProject, NavPrefs, TagNode } from "./model.ts";
import type { RowContext } from "./rows.tsx";

// What the sidebar's panes share: the app's state and actions, the navigator's preferences and
// data, the drag controller and the few things one pane asks of another (focus, selection).

export type Toast = string | import("../../top-notice.ts").Note;

export type SidebarActions = {
  openSession: (session: Session) => void;
  closeWebTab?: (session: Session) => void;
  openWork: (work: Work) => void;
  openDoc: (artifact: Artifact) => void;
  /** A document with this AI beside it (the view switches to it if the document is already open). */
  openDocAgent?: (artifact: Artifact, agent: Session) => void;
  /** The start screen, for a new work (in a folder) — or a new session in a work right away. */
  newSession: (target: { folderId?: string | null; work?: Work; provider?: Provider }) => void;
  createFolder: (name: string, parentId: string | null) => Promise<void>;
  rename: (target: { kind: "folder" | "work" | "session"; id: string }, name: string) => void;
  move: (move: Move) => void;
  /** The menu for a row (built by the app, which knows every action). */
  menuFor: (row: Row, x: number, y: number, removal?: DocumentRemovalPlan) => MenuRequest | null;
  /** What "삭제" of a document would do now (the gateway's decision; the menu words its item by it). */
  docRemoval?: (artifact: Artifact) => Promise<DocumentRemovalPlan>;
  openMenu: (request: MenuRequest) => void;
  /** Blank documents/designs and parallel sessions in this project, also from empty space. */
  creationMenu?: (work: Work | null, x: number, y: number, folderId?: string | null) => void;
  archive: (target: { kind: "folder" | "work" | "session"; id: string }) => void;
  openSearch: () => void;
  openArchive: () => void;
  /** Read the engines' plan limits again. */
  refreshUsage: () => Promise<unknown>;
  /** Home: what is going on across all works, and a new session. */
  openHome: () => void;
  /** A new Markdown page in a work (the "+" on a work row). */
  newPage: (work: Work) => void;
  /** "세션 잇기" for two sessions (a session row dropped on the middle of another). */
  linkSessions: (sessions: [Session, Session]) => void;
  /** "다른 곳의 대화 가져오기": a terminal's or another app's Claude Code / Codex conversation. */
  importConversations: () => void;
  /** A subpage of a page (the "+" on a page row): `A/` beside `A.md`. */
  newSubpage?: (artifact: Artifact) => void;
  /** A session dropped on a work row: its record as a page of that work ("세션 기록 페이지"). */
  sessionPage?: (session: Session, work: Work) => void;
  /** "오른쪽에 열기" (Ctrl+click, middle click): the row in the right pane. Absent where there are no panes. */
  openRight?: (item: PaneItem) => void;
};

/** A dialog the navigator shows over everything. */
export type NavDialog =
  | { kind: "delete"; folder: Folder }
  | { kind: "style"; folder: Folder; x: number; y: number }
  | { kind: "tags"; works: Work[]; x: number; y: number };

export type NavShared = {
  state: State;
  api: Api;
  actions: SidebarActions;
  layout: NavLayout;
  nav: NavPrefs;
  saveNav: (patch: Partial<NavigatorPrefs>) => void;
  shortcuts: NavShortcut[];
  saveShortcuts: (next: NavShortcut[]) => void;
  summaries: Map<string, ProjectSummary>;
  stages: ProjectStage[];
  projects: ListProject[];
  tags: { nodes: TagNode[]; untagged: number };
  counts: { folders: Map<string, { own: number; below: number }>; root: { own: number; below: number } };
  /** The tree's open state (folded folders, unfolded works and documents), shared with the list. */
  open: TreeOpenState;
  onOpenChange: (next: TreeOpenState) => void;
  sortMode: SortMode;
  currentWorkId: string | null;
  visibleSessionId: string | null;
  currentDocId: string | null;
  homeActive: boolean;
  theme: "light" | "dark";
  lookOf: (provider: Provider) => Look;
  /** Rows as the tree shows them (for a project unfolded in the list, the tree layout). */
  rowCtx: RowContext;
  press: (payload: DragPayload, event: ReactPointerEvent) => void;
  justDragged: () => boolean;
  select: (selection: NavSelection) => void;
  /** Focus the list (its current or first row, or `id`). */
  focusList: (id?: string | null) => void;
  /** Focus the navigation pane's selected row. */
  focusNav: () => void;
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  creatingIn: string | null | undefined;
  setCreatingIn: (parentId: string | null | undefined) => void;
  setDialog: (dialog: NavDialog | null) => void;
  /** Projects into a folder, or out of folders (null). */
  moveProjects: (works: Work[], folderId: string | null) => void;
  /** A row's menu: the app's, with the navigator's items (바로가기, a folder's colour and delete). */
  rowMenu: (row: Row, x: number, y: number) => void;
  /** A menu of the navigator's own under one of its buttons, on the shared Menu (above the lists and their scrollbars). */
  menuUnder: (request: MenuRequest, button: HTMLElement) => void;
  toast: (message: Toast) => void;
  fail: (error: unknown) => void;
};
