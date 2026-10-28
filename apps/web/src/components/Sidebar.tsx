import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { FORMAT_LABEL, PROVIDER_LABEL, isUnseen, type Artifact, type Folder, type Provider, type Session, type Work } from "@workbench/contracts";
import type { State } from "../state.ts";
import { holds, moveFor, nowSessions, nudge, pinnedItems, toggleWork, treeRows, zoneAt, type DropZone, type Move, type Row, type SortMode, type TreeOpenState } from "../tree.ts";
import { statusText, statusTone } from "../format.ts";
import { accentStyle, lookStyle, NEUTRAL_LOOK, useAppearance } from "../appearance.ts";
import { EditableText } from "./EditableText.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import type { MenuEntry, MenuRequest } from "./ContextMenu.tsx";
import { UsageCard } from "./UsageCard.tsx";

// The sidebar: where many sessions live. "지금" (waiting for you, working, new replies) on top,
// then pinned things, then the folder tree of works with their sessions and documents. Rows move by
// dragging (above / inside / below) or with Alt+↑↓, rename in place (F2), and open a menu on
// right-click or Shift+F10. Archived things leave the tree for the archive.

export type SidebarActions = {
  openSession: (session: Session) => void;
  openWork: (work: Work) => void;
  openDoc: (artifact: Artifact) => void;
  /** The start screen, for a new work (in a folder) — or a new session in a work right away. */
  newSession: (target: { folderId?: string | null; work?: Work; provider?: Provider }) => void;
  createFolder: (name: string, parentId: string | null) => Promise<void>;
  rename: (target: { kind: "folder" | "work" | "session"; id: string }, name: string) => void;
  move: (move: Move) => void;
  /** The menu for a row (built by the app, which knows every action). */
  menuFor: (row: Row, x: number, y: number) => MenuRequest | null;
  openMenu: (request: MenuRequest) => void;
  archive: (target: { kind: "folder" | "work" | "session"; id: string }) => void;
  openSearch: () => void;
  openArchive: () => void;
  /** Read the engines' plan limits again. */
  refreshUsage: () => Promise<unknown>;
};

const MIN_WIDTH = 232;
const MAX_WIDTH = 480;

const DOC_ICON: Partial<Record<Artifact["format"], IconName>> = { markdown: "page", text: "page", design: "palette" };

function docIcon(artifact: Artifact): IconName {
  if (artifact.format === "markdown" && /\.(mindmap|mm)\.md$/i.test(artifact.name)) return "mindmap";
  return DOC_ICON[artifact.format] ?? "file";
}

type Drag = { row: Row; startX: number; startY: number; active: boolean; x: number; y: number; target: { id: string; zone: DropZone; move: Move | null } | null };

export function Sidebar({
  state,
  currentWorkId,
  visibleSessionId,
  currentDocId,
  open,
  onOpenChange,
  sortMode,
  onSortMode,
  width,
  onWidth,
  actions,
  pending,
  onPendingDone,
}: {
  state: State;
  currentWorkId: string | null;
  visibleSessionId: string | null;
  currentDocId: string | null;
  open: TreeOpenState;
  onOpenChange: (next: TreeOpenState) => void;
  sortMode: SortMode;
  onSortMode: (mode: SortMode) => void;
  width: number;
  onWidth: (width: number) => void;
  actions: SidebarActions;
  /** A rename or a new folder asked from a menu. */
  pending: { rename?: string; createIn?: string | null } | null;
  onPendingDone: () => void;
}) {
  const { lookOf, appTheme } = useAppearance();
  const rows = useMemo(() => treeRows(state, open, sortMode, currentWorkId), [state, open, sortMode, currentWorkId]);
  const now = useMemo(() => nowSessions(state, visibleSessionId), [state, visibleSessionId]);
  const pinned = useMemo(() => pinnedItems(state), [state]);
  const archivedCount =
    Object.values(state.folders).filter((folder) => folder.archivedAt).length +
    Object.values(state.works).filter((work) => work.archivedAt).length +
    Object.values(state.sessions).filter((session) => session.archivedAt).length;

  const [focusId, setFocusId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
  const [folderName, setFolderName] = useState("");
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);

  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  // Menus ask for an inline rename or a new folder; the row may first need its parents unfolded.
  useEffect(() => {
    if (!pending) return;
    if (pending.rename !== undefined) setRenaming(pending.rename);
    if (pending.createIn !== undefined) {
      setCreatingIn(pending.createIn);
      if (pending.createIn && open.closedFolders.includes(pending.createIn)) onOpenChange({ ...open, closedFolders: open.closedFolders.filter((id) => id !== pending.createIn) });
    }
    onPendingDone();
  }, [pending, onPendingDone, open, onOpenChange]);

  // Keyboard focus follows the rows that exist (a folded parent takes the focus of its child).
  useEffect(() => {
    if (focusId && !rowById.has(focusId)) setFocusId(null);
  }, [focusId, rowById]);

  const focusRow = (id: string) => {
    setFocusId(id);
    window.requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus());
  };

  const toggle = (row: Row) => {
    if (row.type === "folder") {
      const closed = new Set(open.closedFolders);
      if (row.open) closed.add(row.id);
      else closed.delete(row.id);
      onOpenChange({ ...open, closedFolders: [...closed] });
    } else if (row.type === "work" && row.expandable) {
      onOpenChange(toggleWork(open, row.id, row.open));
    } else if (row.type === "docs") {
      const docs = new Set(open.openDocs);
      if (row.open) docs.delete(row.work.id);
      else docs.add(row.work.id);
      onOpenChange({ ...open, openDocs: [...docs] });
    }
  };

  const activate = (row: Row) => {
    if (row.type === "folder" || row.type === "docs") return toggle(row);
    if (row.type === "work") return actions.openWork(row.work);
    if (row.type === "session") return actions.openSession(row.session);
    if (row.type === "doc") return actions.openDoc(row.artifact);
  };

  const parentOf = (row: Row): Row | undefined => {
    const index = rows.indexOf(row);
    for (let at = index - 1; at >= 0; at -= 1) if (rows[at]!.depth < row.depth && rows[at]!.type !== "section") return rows[at];
    return undefined;
  };

  const openMenuAt = (row: Row, x: number, y: number) => {
    const request = actions.menuFor(row, x, y);
    if (request) actions.openMenu(request);
  };

  const onRowKey = (event: ReactKeyboardEvent, row: Row) => {
    const navigable: Row[] = rows.filter((entry) => entry.type !== "section");
    const index = navigable.indexOf(row);
    const expandable = (row.type === "folder" && !row.empty) || (row.type === "work" && row.expandable) || row.type === "docs";
    const isOpen = (row.type === "folder" || row.type === "work" || row.type === "docs") && row.open;
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const move = nudge(state, row, event.key === "ArrowUp" ? -1 : 1, sortMode);
      if (move) actions.move(move);
    } else if (event.key === "ArrowDown") {
      const next = navigable[index + 1];
      if (next) focusRow(next.id);
    } else if (event.key === "ArrowUp") {
      const previous = navigable[index - 1];
      if (previous) focusRow(previous.id);
    } else if (event.key === "ArrowRight") {
      if (expandable && !isOpen) toggle(row);
      else if (expandable && navigable[index + 1]) focusRow(navigable[index + 1]!.id);
    } else if (event.key === "ArrowLeft") {
      if (expandable && isOpen) toggle(row);
      else {
        const parent = parentOf(row);
        if (parent) focusRow(parent.id);
      }
    } else if (event.key === "Home") {
      if (navigable[0]) focusRow(navigable[0].id);
    } else if (event.key === "End") {
      const last = navigable.at(-1);
      if (last) focusRow(last.id);
    } else if (event.key === "Enter") {
      activate(row);
    } else if (event.key === "F2" && (row.type === "folder" || row.type === "work" || row.type === "session")) {
      setRenaming(row.id);
    } else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(row, rect.left + 24, rect.bottom - 4);
    } else if (event.key === "Delete" && (row.type === "folder" || row.type === "work" || row.type === "session")) {
      actions.archive({ kind: row.type, id: row.id });
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Dragging with the pointer (works in every webview, unlike HTML drag and drop under Tauri).
  const onPointerDown = (event: ReactPointerEvent, row: Row) => {
    if (event.button !== 0 || renaming) return;
    if (row.type !== "folder" && row.type !== "work" && row.type !== "session") return;
    const target = event.target as HTMLElement;
    if (target.closest("input, .row-chevron")) return;
    dragRef.current = { row, startX: event.clientX, startY: event.clientY, active: false, x: event.clientX, y: event.clientY, target: null };
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return;
      let target: Drag["target"] = null;
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-row-id]");
      const row = element ? rowById.get(element.dataset.rowId!) : undefined;
      if (element && row && row.id !== current.row.id) {
        const rect = element.getBoundingClientRect();
        const zone = zoneAt(event.clientY - rect.top, rect.height, holds(row, current.row));
        target = { id: row.id, zone, move: moveFor(state, current.row, row, zone, sortMode) };
      }
      const next = { ...current, active: true, x: event.clientX, y: event.clientY, target };
      dragRef.current = next;
      setDrag(next);
    };
    const finish = (commit: boolean) => {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!current?.active) return;
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      if (commit && current.target?.move) actions.move(current.target.move);
    };
    const onUp = () => finish(true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current?.active) {
        event.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [rowById, state, sortMode, actions]);

  // Resize from the right edge (remembered).
  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let latest = width;
    const onMove = (move: PointerEvent) => {
      latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + move.clientX - startX));
      setLiveWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLiveWidth(null);
      if (latest !== width) onWidth(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const sessionRow = (session: Session, label: string, onOpen: () => void, extraClass = "") => {
    const unseen = isUnseen(session) && session.id !== visibleSessionId;
    const tone = statusTone(session);
    return (
      <button
        key={session.id}
        type="button"
        className={`side-row now-row${session.id === visibleSessionId ? " current" : ""}${extraClass}`}
        style={accentStyle(lookOf(session.provider))}
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const work = state.works[session.workId];
          if (work) openMenuAt({ type: "session", id: session.id, depth: 0, session, work }, event.clientX, event.clientY);
        }}
        title={`${state.works[session.workId]?.title ?? ""} · ${session.purpose} · ${statusText(session)}`}
      >
        <span className={`dot dot-${tone === "idle" && unseen ? "new" : tone}`} />
        <span className="side-row-label">{label}</span>
        <EngineMark provider={session.provider} size={13} className="side-row-engine" />
      </button>
    );
  };

  const nowGroups: { key: string; label: string; sessions: Session[] }[] = [
    { key: "attention", label: "확인 필요", sessions: now.attention },
    { key: "running", label: "진행 중", sessions: now.running },
    { key: "unseen", label: "새 답", sessions: now.unseen },
  ].filter((group) => group.sessions.length);

  const rowClass = (row: Row) => {
    const classes = ["side-row", `row-${row.type}`];
    if (row.id === focusId) classes.push("focused");
    if (row.type === "work" && row.id === currentWorkId && !visibleSessionId) classes.push("current");
    if (row.type === "work" && row.id === currentWorkId && !row.open) classes.push("current");
    if (row.type === "session" && row.id === visibleSessionId) classes.push("current");
    if (row.type === "doc" && row.id === currentDocId) classes.push("current");
    if (drag?.active && drag.row.id === row.id) classes.push("dragging");
    if (drag?.active && drag.target?.id === row.id) classes.push(drag.target.move ? `drop-${drag.target.zone}` : "drop-refused");
    return classes.join(" ");
  };

  const renderRow = (row: Row) => {
    if (row.type === "section") {
      return (
        <div
          key={row.id}
          className={`side-section-label${drag?.active && drag.target?.id === row.id ? (drag.target.move ? " drop-inside" : " drop-refused") : ""}`}
          data-row-id={row.id}
        >
          {row.label}
        </div>
      );
    }
    const indent: CSSProperties = { paddingLeft: 8 + row.depth * 14 };
    const expandable = (row.type === "folder" && !row.empty) || (row.type === "work" && row.expandable) || row.type === "docs";
    const isOpen = (row.type === "folder" || row.type === "work" || row.type === "docs") && row.open;
    const chevron = (
      <span
        className={`row-chevron${expandable ? "" : " blank"}`}
        onClick={(event) => {
          if (!expandable) return;
          event.stopPropagation();
          toggle(row);
        }}
        aria-hidden
      >
        {expandable ? <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={13} /> : null}
      </span>
    );
    if (renaming === row.id && (row.type === "folder" || row.type === "work" || row.type === "session")) {
      const value = row.type === "folder" ? row.folder.name : row.type === "work" ? row.work.title : row.session.purpose;
      return (
        <div key={row.id} className="side-row renaming" style={indent} data-row-id={row.id}>
          {chevron}
          <Icon name={row.type === "folder" ? "folder" : row.type === "work" ? "project" : "chat"} size={15} />
          <EditableText
            className="side-rename"
            value={value}
            onSave={(next) => actions.rename({ kind: row.type, id: row.id }, next)}
            onDone={() => {
              setRenaming(null);
              focusRow(row.id);
            }}
          />
        </div>
      );
    }
    let icon: IconName = "folder";
    let label = "";
    let trailing = null;
    let style: CSSProperties = indent;
    let title: string | undefined;
    if (row.type === "folder") {
      label = row.folder.name;
    } else if (row.type === "work") {
      icon = "project";
      label = row.work.title;
      const attention = row.sessions.some((session) => session.status === "awaitingApproval");
      const busy = row.sessions.some((session) => session.status === "starting" || session.status === "running" || session.status === "interrupting");
      const unseen = row.sessions.some((session) => session.id !== visibleSessionId && isUnseen(session));
      const only = row.sessions.length === 1 ? row.sessions[0] : null;
      trailing = (
        <span className="side-row-trail">
          {only ? <EngineMark provider={only.provider} size={13} className="side-row-engine" /> : null}
          {attention ? <span className="dot dot-attention" title="확인 필요" /> : busy ? <span className="dot dot-active" title="진행 중" /> : unseen ? <span className="dot dot-new" title="새 답" /> : null}
        </span>
      );
      title = row.work.cwd;
    } else if (row.type === "session") {
      icon = "chat";
      label = row.session.purpose;
      style = { ...indent, ...accentStyle(lookOf(row.session.provider)) };
      const tone = statusTone(row.session);
      const unseen = row.session.id !== visibleSessionId && isUnseen(row.session);
      trailing = (
        <span className="side-row-trail">
          <EngineMark provider={row.session.provider} size={13} className="side-row-engine" />
          {tone !== "idle" ? <span className={`dot dot-${tone}`} title={statusText(row.session)} /> : unseen ? <span className="dot dot-new" title="새 답" /> : null}
        </span>
      );
      title = `${PROVIDER_LABEL[row.session.provider]} · ${statusText(row.session)}`;
    } else if (row.type === "docs") {
      icon = "file";
      label = `문서 ${row.count}`;
    } else if (row.type === "doc") {
      icon = docIcon(row.artifact);
      label = row.artifact.name;
      trailing = <span className="side-row-trail muted">r{row.artifact.revision}</span>;
      title = `${FORMAT_LABEL[row.artifact.format]} · ${row.artifact.path}`;
    }
    return (
      <div
        key={row.id}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={expandable ? isOpen : undefined}
        aria-selected={row.id === visibleSessionId || row.id === currentDocId}
        tabIndex={row.id === focusId || (!focusId && row === rows.find((entry) => entry.type !== "section")) ? 0 : -1}
        className={rowClass(row)}
        style={style}
        data-row-id={row.id}
        title={title}
        onPointerDown={(event) => onPointerDown(event, row)}
        onClick={() => {
          if (suppressClick.current) return;
          setFocusId(row.id);
          activate(row);
        }}
        onDoubleClick={() => (row.type === "folder" || row.type === "work" || row.type === "session") && setRenaming(row.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setFocusId(row.id);
          openMenuAt(row, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => onRowKey(event, row)}
        onFocus={() => setFocusId(row.id)}
      >
        {chevron}
        <Icon name={icon} size={15} className="side-row-icon" />
        <span className="side-row-label">{label}</span>
        {trailing}
      </div>
    );
  };

  const creatingRow = (
    <form
      className="side-row creating"
      onSubmit={(event) => {
        event.preventDefault();
        const name = folderName.trim();
        if (!name) return;
        void actions.createFolder(name, creatingIn ?? null).then(() => {
          setCreatingIn(undefined);
          setFolderName("");
        });
      }}
    >
      <span className="row-chevron blank" />
      <Icon name="folder" size={15} />
      <input
        autoFocus
        value={folderName}
        placeholder="새 폴더 이름"
        onChange={(event) => setFolderName(event.target.value)}
        onBlur={() => !folderName.trim() && setCreatingIn(undefined)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setCreatingIn(undefined);
            setFolderName("");
          }
        }}
      />
    </form>
  );

  // The sort choices open as the app's own menu (drawn above everything, never clipped by the tree).
  const openSort = (button: HTMLElement) => {
    const box = button.getBoundingClientRect();
    const choices: [SortMode, string][] = [
      ["manual", "직접 정한 순서"],
      ["recent", "최근 활동 순"],
      ["name", "이름 순"],
    ];
    actions.openMenu({
      x: box.left,
      y: box.bottom + 4,
      title: "정렬",
      items: choices.map(([mode, label]) => ({ kind: "item" as const, label, checked: sortMode === mode, onSelect: () => onSortMode(mode) })),
    });
  };

  return (
    <aside className="sidebar look-scope" aria-label="세션과 작업" data-theme={appTheme} style={{ ...lookStyle(NEUTRAL_LOOK[appTheme]), width: liveWidth ?? width }}>
      <div className="side-head">
        <button type="button" className="side-new" onClick={() => actions.newSession({})} title="새 세션 (Ctrl+N)">
          <Icon name="plus" size={15} /> 새 세션
        </button>
        <button type="button" className="side-search" onClick={actions.openSearch} title="찾기 (Ctrl+K)">
          <Icon name="search" size={15} />
          <span>찾기</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>

      <div className="side-scroll">
        {nowGroups.length ? (
          <section className="side-section side-now" aria-label="지금">
            <div className="side-section-title">지금</div>
            {nowGroups.map((group) => (
              <div key={group.key} className={`now-group now-${group.key}`}>
                <div className="now-group-label">
                  {group.label} <span className="count">{group.sessions.length}</span>
                </div>
                {group.sessions.map((session) =>
                  sessionRow(session, `${state.works[session.workId]?.title ?? ""} — ${session.purpose}`, () => actions.openSession(session)),
                )}
              </div>
            ))}
          </section>
        ) : null}

        {pinned.works.length || pinned.sessions.length ? (
          <section className="side-section" aria-label="고정">
            <div className="side-section-title">고정</div>
            {pinned.works.map((work) => (
              <button
                key={work.id}
                type="button"
                className={`side-row pinned-row${work.id === currentWorkId ? " current" : ""}`}
                onClick={() => actions.openWork(work)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const row = rowById.get(work.id) ?? { type: "work" as const, id: work.id, depth: 0, work, open: false, expandable: false, sessions: [], docs: [] };
                  openMenuAt(row, event.clientX, event.clientY);
                }}
              >
                <Icon name="pin" size={14} className="side-row-icon" />
                <span className="side-row-label">{work.title}</span>
              </button>
            ))}
            {pinned.sessions.map((session) => sessionRow(session, session.purpose, () => actions.openSession(session), " pinned-row"))}
          </section>
        ) : null}

        <section className="side-section side-tree-section" aria-label="작업 공간">
          <div className="side-section-title with-tools">
            <span>작업 공간</span>
            <span className="side-tools">
              <button type="button" className="icon-button small" title="새 폴더" onClick={() => setCreatingIn(null)}>
                <Icon name="plus" size={13} />
              </button>
              <button type="button" className="icon-button small" title="정렬" aria-haspopup="menu" onClick={(event) => openSort(event.currentTarget)}>
                <Icon name="dots" size={13} />
              </button>
            </span>
          </div>
          <div className="side-tree" role="tree" aria-label="작업 공간" ref={treeRef}>
            {creatingIn === null ? creatingRow : null}
            {rows.map((row) => (
              <div key={row.id} className="side-tree-item">
                {renderRow(row)}
                {creatingIn !== undefined && creatingIn === row.id && row.type === "folder" ? <div style={{ paddingLeft: 14 * (row.depth + 1) }}>{creatingRow}</div> : null}
              </div>
            ))}
            {!rows.length && creatingIn === undefined ? <div className="empty-hint side-empty">아직 작업이 없습니다. 위의 "새 세션"으로 시작하세요.</div> : null}
          </div>
        </section>
      </div>

      <div className="side-foot">
        <UsageCard providers={state.providers} onRefresh={actions.refreshUsage} />
        <button type="button" className="side-row" onClick={actions.openArchive} title="보관한 세션·작업·폴더">
          <Icon name="archive" size={15} className="side-row-icon" />
          <span className="side-row-label">보관함</span>
          {archivedCount ? <span className="side-row-trail muted">{archivedCount}</span> : null}
        </button>
      </div>
      <div className="side-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="사이드바 너비" />
      {drag?.active ? (
        <div className={`drag-ghost${drag.target?.move ? "" : " refused"}`} style={{ left: drag.x + 12, top: drag.y + 10 }}>
          {drag.row.type === "folder" ? drag.row.folder.name : drag.row.type === "work" ? drag.row.work.title : drag.row.type === "session" ? drag.row.session.purpose : ""}
        </div>
      ) : null}
    </aside>
  );
}

/** A folder row for menus built outside the tree (e.g. from the archive). */
export const folderRow = (folder: Folder): Row => ({ type: "folder", id: folder.id, depth: 0, folder, open: true, empty: false });
export type { MenuEntry };
