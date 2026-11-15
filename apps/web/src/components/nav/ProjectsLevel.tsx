import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject } from "react";
import { ItemIcon } from "../ItemIcon.tsx";
import type { Folder, NavSortKey, Work } from "@workbench/contracts";
import type { Row } from "../../tree.ts";
import { EditableText } from "../EditableText.tsx";
import { Icon, iconName } from "../Icon.tsx";
import type { MenuEntry } from "../ContextMenu.tsx";
import { LinkBadge } from "../LinkSidebar.tsx";
import { PlacementMark, ViewsSection } from "../pkm/ViewsSection.tsx";
import { linkOfSession } from "../../links.ts";
import { DEFAULT_SORT, SORT_LABEL, filterOf, holdings, levelOneRows, selectionKey, shortDate, sortFor, type LevelOneRow, type ListProject } from "./model.ts";
import { ROOT_ROW_ID, ShortcutsSection, TagsSection, viewShortcutEntry } from "./NavPane.tsx";
import { RowAdd, RowMore, StateMark } from "./rows.tsx";
import { ListEmpty } from "./Lists.tsx";
import { typeAhead } from "./focus.ts";
import { ROW_STATES } from "../../row-state.ts";
import { projectActions } from "./projectMenus.ts";
import type { NavShared } from "./shared.ts";

// Level 1 of the list column (N1): every project, in its folders, Obsidian-style. One row height,
// the name, a quiet count of what the project holds and ONE status mark. Folders fold and stay
// folded; 바로가기 sits on top (Slack's starred), 태그 and 저장한 보기 below as sections of this level
// (a tag filters this list). Clicking a project goes inside it (level 2) and brings back its tabs.

const DIRECTION: Record<NavSortKey, [string, string]> = {
  activity: ["최근 것부터", "오래된 것부터"],
  created: ["최근에 만든 것부터", "먼저 만든 것부터"],
  name: ["가나다순", "가나다 역순"],
  due: ["가까운 마감부터", "먼 마감부터"],
  stage: ["앞 단계부터", "뒤 단계부터"],
};
const FIRST_DESC: Record<NavSortKey, boolean> = { activity: true, created: true, name: false, due: false, stage: false };

export type LevelOneState = {
  query: string;
  setQuery: (query: string) => void;
  picked: string[];
  setPicked: (ids: string[]) => void;
  anchor: string | null;
  setAnchor: (id: string | null) => void;
  focusId: string | null;
  setFocusId: (id: string | null) => void;
  /** Where the list was scrolled when level 1 was left (it comes back there). */
  scroll: MutableRefObject<number>;
  /** Keeps the scroll in this window's place (a reload or a new window comes back there too). */
  keepScroll?: (top: number) => void;
  /** The filter field is shown when asked for (찾기, Ctrl+F) or while it holds text. */
  fieldOpen: boolean;
  setFieldOpen: (open: boolean) => void;
};

/** A plain folder wears the item icon (open or closed); a folder the person gave its own icon keeps it, in their colour. */
function FolderMark({ folder, open }: { folder: Folder; open: boolean }) {
  const name = folderIcon(folder, open);
  return name === "folder" || name === "folderOpen" ? <ItemIcon kind={name} size={16} /> : <Icon name={name} size={16} />;
}

function folderIcon(folder: Folder, open: boolean) {
  return iconName(folder.icon) ?? (open ? "folderOpen" : "folder");
}

export function ProjectsLevel({ shared, local, docCount, onChoose, onFolderNew, onSort }: {
  shared: NavShared;
  local: LevelOneState;
  /** Documents per project (the project note left out). */
  docCount: (workId: string) => number;
  /** A project chosen: inside it, with its tabs back. */
  onChoose: (work: Work) => void;
  onFolderNew: (parentId: string | null) => void;
  /** The tree's order (직접 · 최근 · 이름). */
  onSort: (mode: "manual" | "recent" | "name") => void;
}) {
  const { state, actions, nav } = shared;
  const scroller = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const sort = sortFor(nav, { kind: "root" });
  const { rows, count } = useMemo(
    () => levelOneRows(shared.projects, state.folders, { closedFolders: shared.open.closedFolders, query: local.query, filter: nav.selected, sortMode: shared.sortMode, groupBy: nav.groupBy, sort, stages: shared.stages, now: Date.now(), keep: [...(shared.currentWorkId ? [shared.currentWorkId] : []), ...shared.projects.filter((project) => project.attention).map((project) => project.work.id)] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shared.projects, state.folders, shared.open.closedFolders, local.query, nav.selected, shared.sortMode, nav.groupBy, sort.key, sort.desc, shared.stages, shared.currentWorkId],
  );
  const projectIds = useMemo(() => rows.flatMap((row) => (row.type === "project" ? [row.id] : [])), [rows]);
  const menus = projectActions(shared, () => local.setPicked([]));
  const filter = filterOf(nav.selected);

  // Back from inside a project: the list is where it was (folds come from the prefs, the scroll from here).
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = local.scroll.current;
    const keep = () => { local.scroll.current = element.scrollTop; };
    element.addEventListener("scroll", keep, { passive: true });
    return () => {
      element.removeEventListener("scroll", keep);
      local.keepScroll?.(local.scroll.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.scroll]);

  const tabId = local.focusId && rows.some((row) => row.id === local.focusId) ? local.focusId : shared.currentWorkId && projectIds.includes(shared.currentWorkId) ? shared.currentWorkId : (rows.find((row) => row.type !== "group")?.id ?? null);
  const chosenWorks = (work: Work) => (local.picked.length > 1 && local.picked.includes(work.id) ? local.picked.map((id) => state.works[id]).filter((entry): entry is Work => Boolean(entry)) : [work]);
  const workRow = (project: ListProject): Extract<Row, { type: "work" }> => ({ type: "work", id: project.work.id, depth: 0, work: project.work, open: false, expandable: false, sessions: project.sessions, docs: [] });
  const toggleFolder = (id: string, open: boolean) => {
    const closed = new Set(shared.open.closedFolders);
    if (open) closed.add(id);
    else closed.delete(id);
    shared.onOpenChange({ ...shared.open, closedFolders: [...closed] });
  };
  const focusRow = (id: string | null | undefined) => {
    if (!id) return;
    window.requestAnimationFrame(() => tree.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus());
  };
  const step = (from: HTMLElement, offset: number | "first" | "last") => {
    const list = [...(tree.current?.querySelectorAll<HTMLElement>("[data-list-row]") ?? [])];
    const index = list.indexOf(from);
    if (offset === -1 && index === 0) { field.current?.focus(); return null; }
    const next = offset === "first" ? list[0] : offset === "last" ? list.at(-1) : list[Math.max(0, Math.min(list.length - 1, index + offset))];
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
    return next?.dataset.rowId ?? null;
  };

  // ── a project row ───────────────────────────────────────────────────────────────────────
  const projectClick = (event: ReactMouseEvent, project: ListProject) => {
    if (shared.justDragged()) return;
    const id = project.work.id;
    if (event.shiftKey) {
      const from = projectIds.indexOf(local.anchor ?? id);
      const to = projectIds.indexOf(id);
      if (from !== -1 && to !== -1) local.setPicked(projectIds.slice(Math.min(from, to), Math.max(from, to) + 1));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const base = local.picked.length ? local.picked : local.anchor && local.anchor !== id && projectIds.includes(local.anchor) ? [local.anchor] : [];
      local.setPicked(base.includes(id) ? base.filter((entry) => entry !== id) : [...base, id]);
      local.setAnchor(id);
      return;
    }
    local.setPicked([]);
    local.setAnchor(id);
    onChoose(project.work);
  };
  const projectKey = (event: ReactKeyboardEvent<HTMLElement>, project: ListProject) => {
    const element = event.currentTarget;
    const id = project.work.id;
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) shared.rowCtx.onKey(event, workRow(project));
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = step(element, event.key === "ArrowDown" ? 1 : -1);
      if (event.shiftKey && next && projectIds.includes(next)) {
        const from = projectIds.indexOf(local.anchor ?? id);
        const to = projectIds.indexOf(next);
        local.setPicked(projectIds.slice(Math.min(from, to), Math.max(from, to) + 1));
      }
    } else if (event.key === "Home") step(element, "first");
    else if (event.key === "End") step(element, "last");
    else if (event.key === "Enter" || event.key === "ArrowRight") {
      local.setPicked([]);
      local.setAnchor(id);
      onChoose(project.work);
    } else if (event.key === "ArrowLeft") {
      const folderId = project.work.folderId;
      if (folderId && state.folders[folderId]) focusRow(folderId);
    } else if (event.key === "F2") shared.setRenaming(id);
    else if (event.key === "Delete") menus.archive(chosenWorks(project.work));
    else if (event.key === "Escape" && local.picked.length) local.setPicked([]);
    else if ((event.key === "a" || event.code === "KeyA") && (event.ctrlKey || event.metaKey)) local.setPicked(projectIds);
    else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      const box = element.getBoundingClientRect();
      menus.open(chosenWorks(project.work), workRow(project), box.left + 24, box.bottom - 4);
    } else if (!typeAhead(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const projectRow = (row: Extract<LevelOneRow, { type: "project" }>) => {
    const { project } = row;
    const { work } = project;
    const indent = { paddingLeft: 8 + row.depth * 16 } as CSSProperties;
    if (shared.renaming === work.id) {
      return (
        <div key={row.id} className="side-row renaming nav-project" style={indent} data-row-id={work.id}>
          {/* The field sits on the row's one line beside the mark, as the name did (never under it). */}
          <div className="nav-project-line">
            <ItemIcon kind="project" size={15} className="side-row-icon" />
            <EditableText className="side-rename" label={`${work.title} 이름 바꾸기`} value={work.title} onSave={(next) => actions.rename({ kind: "work", id: work.id }, next)} onDone={() => { shared.setRenaming(null); focusRow(work.id); }} />
          </div>
        </div>
      );
    }
    const held = holdings(project, docCount(work.id));
    const waiting = project.needs;
    const here = work.id === shared.currentWorkId;
    const picked = local.picked.includes(work.id);
    const linked = project.sessions.length === 1 ? project.sessions[0]! : project.sessions.find((session) => linkOfSession(state, session.id));
    const kinds = [held.chats ? `대화 ${held.chats}` : "", held.docs ? `문서 ${held.docs}` : "", held.web ? `웹 ${held.web}` : ""].filter(Boolean).join(", ");
    const stage = project.stage ? shared.stages.find((entry) => entry.name === project.stage) : undefined;
    const detailed = nav.density === "standard";
    const classes = ["side-row", "nav-project"];
    if (here) classes.push("current");
    if (picked) classes.push("selected");
    if (local.focusId === work.id) classes.push("focused");
    return (
      <div
        key={row.id}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-label={`${work.title}${waiting ? `, 확인 필요 ${waiting}개` : project.busy ? ", 진행 중" : ""}`}
        aria-current={here ? "true" : undefined}
        aria-selected={picked || here}
        tabIndex={row.id === tabId ? 0 : -1}
        className={classes.join(" ")}
        style={indent}
        data-row-id={work.id}
        data-list-row=""
        title={`${work.title}${kinds ? `\n${kinds}` : ""}\n${work.cwd}`}
        onPointerDown={(event) => {
          if (event.button === 1 && actions.openRight) event.preventDefault();
          if (event.button !== 0 || shared.renaming) return;
          if ((event.target as HTMLElement).closest("input, .row-add")) return;
          shared.press({ kind: "projects", works: chosenWorks(work) }, event);
        }}
        onClick={(event) => projectClick(event, project)}
        onAuxClick={(event) => event.button === 1 && actions.openRight?.({ kind: "project", id: work.id })}
        onDoubleClick={(event) => !event.ctrlKey && !event.metaKey && !event.shiftKey && shared.setRenaming(work.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (local.picked.length && !local.picked.includes(work.id)) local.setPicked([]);
          menus.open(chosenWorks(work), workRow(project), event.clientX, event.clientY);
        }}
        onKeyDown={(event) => projectKey(event, project)}
        onFocus={() => local.setFocusId(work.id)}
      >
        <div className="nav-project-line">
          <ItemIcon kind="project" size={15} className="side-row-icon" />
          <span className="side-row-label">{work.title}</span>
          <span className="side-row-trail">
            <PlacementMark workId={work.id} />
            <RowAdd label="새로 만들기" onAdd={(anchor) => {
              const box = anchor.getBoundingClientRect();
              if (actions.creationMenu) actions.creationMenu(work, box.left, box.bottom);
              else actions.newPage(work);
            }} />
            {linked && linkOfSession(state, linked.id) ? <LinkBadge sessionId={linked.id} /> : null}
            {/* One trailing fact: how many things need the person (a number pill), else a turning mark while at work, else nothing. */}
            {waiting ? <span className="nav-pill" title={`확인 필요 ${waiting}개`} aria-hidden>{waiting}</span> : project.busy ? <span title="진행 중"><StateMark state={ROW_STATES.running} size={14} /></span> : null}
            <RowMore name={work.title} onOpen={(x, y) => menus.open(chosenWorks(work), workRow(project), x, y)} />
          </span>
        </div>
        {detailed ? (
          <div className="nav-project-detail">
            {stage || project.stage ? <span className="stage-stamp plain" style={stage ? ({ "--stage": stage.color } as CSSProperties) : undefined}>{project.stage}</span> : null}
            <span>{shortDate(project.activity)}</span>
            {project.tags.slice(0, 2).map((tag) => <span key={tag}>#{tag}</span>)}
            {nav.previewLines > 0 && project.preview ? <span className="nav-project-preview" style={{ WebkitLineClamp: nav.previewLines } as CSSProperties}>{project.preview}</span> : null}
          </div>
        ) : null}
      </div>
    );
  };

  // ── a folder row ────────────────────────────────────────────────────────────────────────
  const folderRow = (row: Extract<LevelOneRow, { type: "folder" }>) => {
    const { folder } = row;
    const style = { paddingLeft: 8 + row.depth * 16, ...(folder.color ? { "--folder-color": folder.color } : {}) } as CSSProperties;
    const treeRow: Row = { type: "folder", id: folder.id, depth: row.depth, folder, open: row.open, empty: !row.children };
    if (shared.renaming === folder.id) {
      return (
        <div key={row.id} className="side-row renaming nav-folder" style={style} data-row-id={folder.id}>
          <span className="row-chevron blank" />
          <span className="side-row-icon nav-folder-icon"><FolderMark folder={folder} open={row.open} /></span>
          <EditableText className="side-rename" label={`${folder.name} 이름 바꾸기`} value={folder.name} onSave={(next) => actions.rename({ kind: "folder", id: folder.id }, next)} onDone={() => { shared.setRenaming(null); focusRow(folder.id); }} />
        </div>
      );
    }
    const onKey = (event: ReactKeyboardEvent<HTMLElement>) => {
      const element = event.currentTarget;
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) return shared.rowCtx.onKey(event, treeRow);
      if (event.key === "ArrowDown") step(element, 1);
      else if (event.key === "ArrowUp") step(element, -1);
      else if (event.key === "Home") step(element, "first");
      else if (event.key === "End") step(element, "last");
      else if (event.key === "ArrowRight") { if (row.children && !row.open) toggleFolder(folder.id, false); else step(element, 1); }
      else if (event.key === "ArrowLeft") { if (row.children && row.open) toggleFolder(folder.id, true); else if (folder.parentId && state.folders[folder.parentId]) focusRow(folder.parentId); }
      else if (event.key === "Enter" || event.key === " ") toggleFolder(folder.id, row.open);
      else if (!typeAhead(event)) return shared.rowCtx.onKey(event, treeRow);
      event.preventDefault();
      event.stopPropagation();
    };
    return (
      <div
        key={row.id}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={row.children ? row.open : undefined}
        aria-label={`폴더 ${folder.name}, 프로젝트 ${row.count}개`}
        tabIndex={row.id === tabId ? 0 : -1}
        className={`side-row nav-folder${folder.color ? " colored" : ""}${row.open ? " open" : ""}`}
        style={style}
        data-row-id={folder.id}
        data-list-row=""
        data-nav-folder=""
        title={`폴더 ${folder.name}, 프로젝트 ${row.count}개`}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest(".row-add")) return;
          shared.press({ kind: "row", row: treeRow }, event);
        }}
        onClick={(event) => {
          if (shared.justDragged()) return;
          if ((event.button === 1 || event.ctrlKey || event.metaKey) && actions.openRight) actions.openRight({ kind: "folder", id: folder.id });
          else toggleFolder(folder.id, row.open);
        }}
        onAuxClick={(event) => event.button === 1 && actions.openRight?.({ kind: "folder", id: folder.id })}
        onDoubleClick={() => shared.setRenaming(folder.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          shared.rowMenu(treeRow, event.clientX, event.clientY);
        }}
        onKeyDown={onKey}
        onFocus={() => local.setFocusId(folder.id)}
      >
        <span className={`row-chevron${row.children ? "" : " blank"}`} aria-hidden>{row.children ? <Icon name={row.open ? "chevronDown" : "chevronRight"} size={12} /> : null}</span>
        {/* The owner (2026-11-14): a folder LOOKS like a folder — its icon always (closed/open, or the person's own icon and colour). */}
        <span className="side-row-icon nav-folder-icon"><FolderMark folder={folder} open={row.open} /></span>
        <span className="side-row-label nav-folder-name">{folder.name}</span>
        <span className="side-row-trail">
          <RowAdd label="이 폴더에 새 작업" onAdd={() => actions.newSession({ folderId: folder.id })} />
          {/* One trailing fact: how many projects it holds. */}
          {row.count ? <span className="nav-count nav-folder-count" aria-hidden>{row.count}</span> : null}
          <RowMore name={folder.name} onOpen={(x, y) => shared.rowMenu(treeRow, x, y)} />
        </span>
      </div>
    );
  };

  // ── the head: + and 보기 ─────────────────────────────────────────────────────────────────
  const setSort = (next: { key: NavSortKey; desc: boolean }) => shared.saveNav({ sortByFolder: { ...nav.sortByFolder, [selectionKey({ kind: "root" })]: next } });
  const viewMenu = (button: HTMLElement) => {
    const [first, second] = DIRECTION[sort.key];
    const sections = ["shortcuts", "tags", "views"] as const;
    const items: MenuEntry[] = [
      { kind: "label", label: "묶기" },
      { kind: "item", label: "폴더별", hint: "기본", checked: nav.groupBy === "folder", onSelect: () => shared.saveNav({ groupBy: "folder" }) },
      { kind: "item", label: "목록 (정렬대로 묶음)", checked: nav.groupBy === "list", onSelect: () => shared.saveNav({ groupBy: "list" }) },
      { kind: "separator" },
      ...(nav.groupBy === "folder"
        ? [
            { kind: "label" as const, label: "정렬" },
            ...([["manual", "직접 정한 순서"], ["recent", "최근 활동 순"], ["name", "이름 순"]] as const).map(([mode, label]) => ({ kind: "item" as const, label, checked: shared.sortMode === mode, onSelect: () => onSort(mode) })),
          ]
        : [
            { kind: "label" as const, label: "정렬" },
            ...(Object.keys(SORT_LABEL) as NavSortKey[]).map((key) => ({ kind: "item" as const, label: SORT_LABEL[key], checked: sort.key === key, onSelect: () => setSort({ key, desc: sort.key === key ? sort.desc : FIRST_DESC[key] }) })),
            { kind: "separator" as const },
            { kind: "item" as const, label: first, checked: sort.desc === FIRST_DESC[sort.key], onSelect: () => setSort({ key: sort.key, desc: FIRST_DESC[sort.key] }) },
            { kind: "item" as const, label: second, checked: sort.desc !== FIRST_DESC[sort.key], onSelect: () => setSort({ key: sort.key, desc: !FIRST_DESC[sort.key] }) },
            ...(sort.key !== DEFAULT_SORT.key || sort.desc !== DEFAULT_SORT.desc ? [{ kind: "item" as const, label: "처음 기본값으로 (최근 활동)", icon: "restore" as const, onSelect: () => setSort(DEFAULT_SORT) }] : []),
          ]),
      { kind: "separator" },
      {
        kind: "submenu",
        label: "줄 모양",
        icon: "list",
        items: [
          { kind: "item", label: "한 줄", checked: nav.density === "compact", onSelect: () => shared.saveNav({ density: "compact" }) },
          { kind: "item", label: "자세히 (단계·날짜·태그)", checked: nav.density === "standard", onSelect: () => shared.saveNav({ density: "standard" }) },
          { kind: "separator" },
          ...([0, 1, 2, 3] as const).map((lines) => ({ kind: "item" as const, label: lines ? `미리보기 ${lines}줄` : "미리보기 없음", checked: nav.previewLines === lines, disabled: nav.density !== "standard", onSelect: () => shared.saveNav({ previewLines: lines }) })),
        ],
      },
      ...(actions.openHomeView ? [{ kind: "item" as const, label: "보드와 표로 보기", icon: "columns" as const, onSelect: () => actions.openHomeView!("projects") }] : []),
      { kind: "item", label: "새 폴더", icon: "folder", onSelect: () => onFolderNew(null) },
      { kind: "separator" },
      { kind: "item", label: "모든 섹션 펼치기", icon: "expandAll", onSelect: () => shared.saveNav({ sections: {} }) },
      { kind: "item", label: "모든 섹션 접기", icon: "collapseAll", onSelect: () => shared.saveNav({ sections: Object.fromEntries(sections.map((id) => [id, true])) }) },
      { kind: "item", label: "모든 폴더 접기", icon: "collapseAll", onSelect: () => shared.onOpenChange({ ...shared.open, closedFolders: Object.keys(state.folders) }) },
      { kind: "separator" },
      { kind: "item", label: "다른 곳의 대화 가져오기…", icon: "restore", onSelect: actions.importConversations },
    ];
    shared.menuUnder({ x: button.getBoundingClientRect().left, y: button.getBoundingClientRect().bottom + 4, title: "보기", items }, button);
  };

  const anyProjects = shared.projects.length > 0;
  return (
    <div className="nav-level nav-level-one" data-level="projects"
      // Escape in level 1 clears a tag filter (a field or menu that used the key first keeps it).
      onKeyDown={(event) => { if (event.key === "Escape" && filter && !event.defaultPrevented && !(event.target as HTMLElement).closest("input, textarea")) { event.preventDefault(); shared.select({ kind: "root" }); } }}>
      <div className="nav-head">
        <h2 className="nav-title">프로젝트</h2>
        <span className="nav-head-tools">
          <button type="button" className={`icon-button small nav-find${local.fieldOpen || local.query ? " pressed" : ""}`} aria-label="찾기" aria-expanded={local.fieldOpen || Boolean(local.query)} title="프로젝트·폴더 찾기 (Ctrl+F)" onClick={() => {
            if (local.fieldOpen && !local.query) local.setFieldOpen(false);
            else { local.setFieldOpen(true); window.requestAnimationFrame(() => field.current?.focus()); }
          }}>
            <Icon name="search" size={16} />
          </button>
          <button type="button" className="icon-button small nav-view" aria-haspopup="menu" aria-label="보기" title="보기: 묶기, 정렬, 줄 모양" onClick={(event) => viewMenu(event.currentTarget)}>
            <Icon name="sort" size={16} />
          </button>
        </span>
      </div>
      {/* The one filled key of the column (the owner's draft: "새 작업" under the head), the creation menu. */}
      <button type="button" className="button primary nav-new" aria-haspopup="menu" title="새 프로젝트·문서·세션·폴더" onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        if (actions.creationMenu) actions.creationMenu(shared.currentWorkId ? state.works[shared.currentWorkId] ?? null : null, box.left, box.bottom);
        else actions.newSession({});
      }}>
        <Icon name="plus" size={16} />
        <span>새로 만들기</span>
      </button>
      {local.fieldOpen || local.query ? <label className="nav-field">
        <Icon name="search" size={14} />
        <input
          ref={field}
          value={local.query}
          placeholder="프로젝트·폴더 찾기"
          aria-label="프로젝트·폴더 찾기"
          title="이름, #태그, 단계:값, 폴더:이름, 속성:값 (앞에 -를 붙이면 제외)"
          spellCheck={false}
          onChange={(event) => local.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (local.query) local.setQuery(""); else local.setFieldOpen(false); }
            else if (event.key === "ArrowDown") { event.preventDefault(); tree.current?.querySelector<HTMLElement>("[data-list-row]")?.focus(); }
          }}
        />
      </label> : null}
      {filter ? (
        <div className="nav-filter">
          <span className="nav-filter-label"><Icon name="hash" size={13} />{filter.kind === "tag" ? filter.tag : "태그 없음"}</span>
          <span className="nav-filter-count">{count}</span>
          <button type="button" className="icon-button small" aria-label="태그 거르기 풀기" title="태그 거르기 풀기" onClick={() => shared.select({ kind: "root" })}><Icon name="x" size={13} /></button>
        </div>
      ) : null}
      <div className="nav-scroll side-scroll" ref={scroller}>
        <ShortcutsSection shared={shared} />
        <section className="side-section nav-projects" aria-label="프로젝트">
          {/* The concept named once (the owner: folders of projects are the app's own idea): a quiet head 폴더 with +. */}
          {nav.groupBy === "folder" ? (
            <div className="nav-folders-head">
              <span className="nav-folders-title">폴더</span>
              <button type="button" className="icon-button small nav-folders-add" aria-label="새 폴더" title="새 폴더" onClick={() => onFolderNew(null)}><Icon name="plus" size={14} /></button>
            </div>
          ) : null}
          {nav.groupBy === "folder" && !Object.values(state.folders).some((folder) => !folder.archivedAt) && shared.creatingIn !== null ? (
            <ListEmpty line="폴더를 만들어 프로젝트를 묶을 수 있습니다." action="새 폴더" onAction={() => onFolderNew(null)} />
          ) : null}
          {shared.creatingIn === null ? <NewFolderRow shared={shared} depth={0} /> : null}
          <div className="side-tree nav-tree" role="tree" aria-label="폴더별 프로젝트" aria-multiselectable ref={tree}>
            {rows.map((row) => (
              row.type === "group" ? (
                <div key={row.id} className="nav-group" role="presentation" data-row-id={row.id === "group:loose" ? ROOT_ROW_ID : undefined} data-nav-folder={row.id === "group:loose" ? "" : undefined}><span>{row.label}</span><span className="nav-count">{row.count}</span></div>
              ) : row.type === "folder" ? (
                <div key={row.id} role="none" className="nav-tree-item">
                  {folderRow(row)}
                  {shared.creatingIn === row.id ? <NewFolderRow shared={shared} depth={row.depth + 1} /> : null}
                </div>
              ) : projectRow(row)
            ))}
          </div>
          {!count ? (
            !anyProjects ? <ListEmpty line="아직 프로젝트가 없습니다." action="새 프로젝트" onAction={(anchor) => { const box = anchor.getBoundingClientRect(); if (actions.creationMenu) actions.creationMenu(null, box.left, box.bottom); else actions.newSession({}); }} />
            : local.query ? <ListEmpty line="찾는 이름의 프로젝트가 없습니다." action="찾기 지우기" onAction={() => local.setQuery("")} />
            : filter ? <ListEmpty line="이 태그가 붙은 프로젝트가 없습니다." action="태그 거르기 풀기" onAction={() => shared.select({ kind: "root" })} /> : null
          ) : null}
        </section>
        <TagsSection shared={shared} />
        <ViewsSection openMenu={actions.openMenu} folded={Boolean(nav.sections.views)} onFold={(folded) => shared.saveNav({ sections: { ...nav.sections, views: folded } })} menuExtras={(view) => [viewShortcutEntry(shared, view.id)]} />
      </div>
    </div>
  );
}

/** The inline "새 폴더 이름" row. */
function NewFolderRow({ shared, depth }: { shared: NavShared; depth: number }) {
  const [name, setName] = useState("");
  return (
    <form
      className="side-row creating"
      style={{ paddingLeft: 8 + depth * 16 }}
      onSubmit={(event) => {
        event.preventDefault();
        const value = name.trim();
        if (!value) return;
        void shared.actions.createFolder(value, shared.creatingIn ?? null).then(() => { shared.setCreatingIn(undefined); setName(""); });
      }}
    >
      <span className="row-chevron blank" />
      <ItemIcon kind="folder" size={15} />
      <input autoFocus value={name} placeholder="새 폴더 이름" aria-label="새 폴더 이름" onChange={(event) => setName(event.target.value)} onBlur={() => !name.trim() && shared.setCreatingIn(undefined)}
        onKeyDown={(event) => { if (event.key === "Escape") { shared.setCreatingIn(undefined); setName(""); } }} />
    </form>
  );
}
