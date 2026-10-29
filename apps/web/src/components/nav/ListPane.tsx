import { memo, useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { NavSortKey, ProjectStage, Work } from "@workbench/contracts";
import type { Row } from "../../tree.ts";
import { folderChoices } from "../../tree.ts";
import { EditableText } from "../EditableText.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { Icon, iconName } from "../Icon.tsx";
import type { MenuEntry } from "../ContextMenu.tsx";
import { LinkBadge, LinkLines } from "../LinkSidebar.tsx";
import { PlacementMark } from "../pkm/ViewsSection.tsx";
import { linkOfSession } from "../../links.ts";
import { DEFAULT_SORT, SORT_LABEL, addShortcuts, dateFor, sameShortcut, selectionKey, shortDate, sortFor, type ListProject } from "./model.ts";
import { RowAdd, TreeRow, type RowContext } from "./rows.tsx";
import type { NavShared } from "./shared.ts";

// The list pane: the projects of what the navigation pane selected, one row per project like a
// note in Notebook Navigator (name, stage, the note's first words, date, tags, sessions), pinned
// ones first and dates in groups. A row's ▸ unfolds its sessions and documents as the tree showed
// them. Click opens; Ctrl/Shift+click picks several to move, pin, tag or archive together.

export type ListItem =
  | { kind: "group"; key: string; label: string; count: number }
  | { kind: "project"; project: ListProject; folder: string | null; row: Extract<Row, { type: "work" }> }
  | { kind: "child"; row: Row };

const DIRECTION: Record<NavSortKey, [string, string]> = {
  activity: ["최근 것부터", "오래된 것부터"],
  created: ["최근에 만든 것부터", "먼저 만든 것부터"],
  name: ["가나다순", "가나다 역순"],
  due: ["가까운 마감부터", "먼 마감부터"],
  stage: ["앞 단계부터", "뒤 단계부터"],
};
/** Which way reads "first" for each key (the first label above). */
const FIRST_DESC: Record<NavSortKey, boolean> = { activity: true, created: true, name: false, due: false, stage: false };

type RowHandlers = {
  press: (event: ReactPointerEvent, project: ListProject) => void;
  click: (event: ReactMouseEvent, project: ListProject) => void;
  aux: (event: ReactMouseEvent, project: ListProject) => void;
  menu: (event: ReactMouseEvent, project: ListProject) => void;
  key: (event: ReactKeyboardEvent<HTMLElement>, project: ListProject, row: Extract<Row, { type: "work" }>) => void;
  focus: (id: string) => void;
  toggle: (row: Extract<Row, { type: "work" }>) => void;
  newPage: (work: Work) => void;
  rename: (work: Work, name: string) => void;
  renameDone: (id: string) => void;
  startRename: (id: string) => void;
};

type ProjectRowProps = {
  project: ListProject;
  folder: string | null;
  row: Extract<Row, { type: "work" }>;
  stage: ProjectStage | undefined;
  sortKey: NavSortKey;
  density: "standard" | "compact";
  previewLines: number;
  current: boolean;
  selected: boolean;
  focused: boolean;
  tab: boolean;
  renaming: boolean;
  /** A session in a live link shown on this row (its only one, or one folded inside it). */
  linkedId: string | null;
  handlers: RowHandlers;
};

const ProjectRow = memo(function ProjectRow({ project, folder, row, stage, sortKey, density, previewLines, current, selected, focused, tab, renaming, linkedId, handlers }: ProjectRowProps) {
  const { work } = project;
  const chevron = (
    <span
      className={`row-chevron${row.expandable ? "" : " blank"}`}
      onClick={(event) => {
        if (!row.expandable) return;
        event.stopPropagation();
        handlers.toggle(row);
      }}
      aria-hidden
    >
      {row.expandable ? <Icon name={row.open ? "chevronDown" : "chevronRight"} size={13} /> : null}
    </span>
  );
  if (renaming) {
    return (
      <div className="side-row renaming nav-project" data-row-id={work.id} data-list-row="">
        <div className="nav-project-line">
          {chevron}
          <EditableText className="side-rename" value={work.title} onSave={(next) => handlers.rename(work, next)} onDone={() => handlers.renameDone(work.id)} />
        </div>
      </div>
    );
  }
  const only = project.sessions.length === 1 ? project.sessions[0] : null;
  const date = dateFor(project, sortKey);
  const dateText = sortKey === "due" ? (date !== null ? `마감 ${shortDate(date, Date.now(), false)}` : "") : shortDate(date);
  const stamp = stage ? (
    <span className="stage-stamp" style={{ "--stage": stage.color } as CSSProperties} title={`단계: ${stage.name}`}>
      {stage.name}
    </span>
  ) : project.stage ? (
    <span className="stage-stamp plain" title={`단계: ${project.stage}`}>
      {project.stage}
    </span>
  ) : null;
  const dot = project.attention ? <span className="dot dot-attention" title="확인 필요" /> : project.busy ? <span className="dot dot-active" title="진행 중" /> : project.unseen ? <span className="dot dot-new" title="새 답" /> : null;
  const tags = project.tags.slice(0, 3);
  const classes = ["side-row", "row-work", "nav-project", density];
  if (current) classes.push("current");
  if (selected) classes.push("selected");
  if (focused) classes.push("focused");
  if (work.pinned) classes.push("pinned");
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-expanded={row.expandable ? row.open : undefined}
      aria-selected={selected || current}
      tabIndex={tab ? 0 : -1}
      className={classes.join(" ")}
      data-row-id={work.id}
      data-list-row=""
      title={work.cwd}
      onPointerDown={(event) => handlers.press(event, project)}
      onClick={(event) => handlers.click(event, project)}
      onAuxClick={(event) => handlers.aux(event, project)}
      onDoubleClick={(event) => {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey) handlers.startRename(work.id);
      }}
      onContextMenu={(event) => handlers.menu(event, project)}
      onKeyDown={(event) => handlers.key(event, project, row)}
      onFocus={() => handlers.focus(work.id)}
    >
      <div className="nav-project-line">
        {chevron}
        <span className="nav-project-title">{work.title}</span>
        {stamp}
        <span className="side-row-trail">
          <PlacementMark workId={work.id} />
          <RowAdd label="새 페이지" onAdd={() => handlers.newPage(work)} />
          {linkedId ? <LinkBadge sessionId={linkedId} /> : null}
          {density === "compact" && dateText ? <span className="nav-project-date">{dateText}</span> : null}
          {only ? <EngineMark provider={only.provider} size={13} className="side-row-engine" /> : null}
          {dot}
        </span>
      </div>
      {density === "standard" && previewLines > 0 && project.preview ? (
        <div className="nav-project-preview" style={{ WebkitLineClamp: previewLines } as CSSProperties}>
          {project.preview}
        </div>
      ) : null}
      {density === "standard" ? (
        <div className="nav-project-meta">
          {dateText ? <span className="nav-project-date">{dateText}</span> : null}
          {folder ? (
            <span className="nav-project-folder" title={folder}>
              <Icon name="folder" size={12} />
              {folder}
            </span>
          ) : null}
          {tags.map((tag) => (
            <span key={tag} className="nav-tag-chip">
              #{tag}
            </span>
          ))}
          {project.tags.length > tags.length ? <span className="nav-tag-chip more">+{project.tags.length - tags.length}</span> : null}
          {project.sessions.length > 1 ? (
            <span className="nav-project-sessions" title={`세션 ${project.sessions.length}개`}>
              <Icon name="chat" size={12} />
              {project.sessions.length}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}, sameRow);

function sameRow(a: ProjectRowProps, b: ProjectRowProps) {
  return (
    a.project === b.project &&
    a.folder === b.folder &&
    a.row.open === b.row.open &&
    a.row.expandable === b.row.expandable &&
    a.stage === b.stage &&
    a.sortKey === b.sortKey &&
    a.density === b.density &&
    a.previewLines === b.previewLines &&
    a.current === b.current &&
    a.selected === b.selected &&
    a.focused === b.focused &&
    a.tab === b.tab &&
    a.renaming === b.renaming &&
    a.linkedId === b.linkedId &&
    a.handlers === b.handlers
  );
}

export function ListPane({
  shared,
  items,
  count,
  selected,
  setSelected,
  anchor,
  setAnchor,
  focusId,
  setFocusId,
  query,
  setQuery,
  filterOpen,
  setFilterOpen,
  treeRef,
}: {
  shared: NavShared;
  items: ListItem[];
  count: number;
  selected: string[];
  setSelected: (ids: string[]) => void;
  anchor: string | null;
  setAnchor: (id: string | null) => void;
  focusId: string | null;
  setFocusId: (id: string | null) => void;
  query: string;
  setQuery: (query: string) => void;
  filterOpen: boolean;
  setFilterOpen: (open: boolean) => void;
  treeRef: RefObject<HTMLDivElement | null>;
}) {
  const { state, actions, api, nav, stages } = shared;
  const selection = nav.selected;
  const sort = sortFor(nav, selection);
  const filterInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (filterOpen) filterInput.current?.focus();
  }, [filterOpen]);

  const projectIds = useMemo(() => items.flatMap((item) => (item.kind === "project" ? [item.project.work.id] : [])), [items]);
  // The one row Tab reaches: the focused one, else the project on screen, else the first.
  const tabId = useMemo(() => {
    if (focusId && items.some((item) => item.kind !== "group" && item.row.id === focusId)) return focusId;
    return shared.currentWorkId && projectIds.includes(shared.currentWorkId) ? shared.currentWorkId : (projectIds[0] ?? null);
  }, [items, projectIds, focusId, shared.currentWorkId]);
  const chosenWorks = (work: Work) => (selected.length > 1 && selected.includes(work.id) ? selected.map((id) => state.works[id]).filter((entry): entry is Work => Boolean(entry)) : [work]);
  const projectOf = (id: string) => shared.projects.find((project) => project.work.id === id);

  // ── what menus do ───────────────────────────────────────────────────────────────────────
  const setStage = (works: Work[], stage: string | null) =>
    void Promise.allSettled(works.map((work) => api.setProjectStage(work.id, stage))).then((results) => {
      const done = results.flatMap((result, index) => (result.status === "fulfilled" ? [{ work: works[index]!, write: result.value }] : []));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) shared.fail(failed.reason);
      if (!done.length) return;
      const undo = () => void Promise.all(done.filter((entry) => entry.write.token).map((entry) => api.undoProject(entry.work.id, entry.write.token))).catch(shared.fail);
      shared.toast({ text: done.length === 1 ? `${done[0]!.work.title}: ${done[0]!.write.summary}` : `단계 ${stage ?? "값 없음"} · 프로젝트 ${done.length}개`, action: { label: "되돌리기", run: undo } });
    });
  const pin = (works: Work[], pinned: boolean) => void Promise.all(works.map((work) => api.updateWork(work.id, { pinned }))).catch(shared.fail);
  const archiveMany = (works: Work[]) =>
    void Promise.allSettled(works.map((work) => api.updateWork(work.id, { archived: true }))).then((results) => {
      const done = works.filter((_, index) => results[index]!.status === "fulfilled");
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) shared.fail(failed.reason);
      if (!done.length) return;
      setSelected([]);
      shared.toast({ text: `프로젝트 ${done.length}개를 보관함으로 옮겼습니다.`, action: { label: "되돌리기", run: () => void Promise.all(done.map((work) => api.updateWork(work.id, { archived: false }))).catch(shared.fail) } });
    });
  const archive = (works: Work[]) => (works.length === 1 ? actions.archive({ kind: "work", id: works[0]!.id }) : archiveMany(works));
  const stageMenu = (works: Work[]): MenuEntry => {
    const current = works.length === 1 ? (projectOf(works[0]!.id)?.stage ?? null) : undefined;
    return {
      kind: "submenu",
      label: "단계",
      icon: "stage",
      items: [
        ...stages.map((stage) => ({ kind: "item" as const, label: stage.name, checked: current === stage.name, onSelect: () => setStage(works, stage.name) })),
        { kind: "separator" as const },
        { kind: "item" as const, label: "값 없음", checked: current === null, onSelect: () => setStage(works, null) },
      ],
    };
  };
  const moveMenu = (works: Work[]): MenuEntry => ({
    kind: "submenu",
    label: "폴더로 옮기기",
    icon: "folder",
    items: [
      { kind: "item", label: "폴더 밖 (프로젝트)", checked: works.every((work) => !work.folderId), onSelect: () => shared.moveProjects(works, null) },
      ...(folderChoices(state).length ? [{ kind: "separator" as const }] : []),
      ...folderChoices(state).map((folder) => ({ kind: "item" as const, label: `${" ".repeat(folder.depth)}${folder.name}`, checked: works.every((work) => work.folderId === folder.id), onSelect: () => shared.moveProjects(works, folder.id) })),
    ],
  });
  const shortcutEntry = (works: Work[]): MenuEntry => {
    const all = works.every((work) => shared.shortcuts.some((entry) => sameShortcut(entry, { kind: "work", id: work.id })));
    return all
      ? { kind: "item", label: "바로가기에서 빼기", icon: "star", onSelect: () => shared.saveShortcuts(shared.shortcuts.filter((entry) => !works.some((work) => sameShortcut(entry, { kind: "work", id: work.id })))) }
      : { kind: "item", label: "바로가기에 더하기", icon: "star", onSelect: () => shared.saveShortcuts(addShortcuts(shared.shortcuts, works.map((work) => ({ kind: "work" as const, id: work.id })))) };
  };
  const tagEntry = (works: Work[], x: number, y: number): MenuEntry => ({ kind: "item", label: "태그 더하기…", icon: "hash", onSelect: () => shared.setDialog({ kind: "tags", works, x, y }) });

  const openMenu = (project: ListProject, x: number, y: number) => {
    const works = chosenWorks(project.work);
    if (works.length > 1) {
      const allPinned = works.every((work) => work.pinned);
      actions.openMenu({
        x,
        y,
        title: `프로젝트 ${works.length}개`,
        items: [
          moveMenu(works),
          shortcutEntry(works),
          { kind: "item", label: allPinned ? "고정 풀기" : "고정", icon: "pin", onSelect: () => pin(works, !allPinned) },
          stageMenu(works),
          tagEntry(works, x, y),
          { kind: "separator" },
          { kind: "item", label: `보관 (${works.length}개)`, icon: "archive", hint: "Delete", onSelect: () => archive(works) },
        ],
      });
      return;
    }
    const row = items.find((item): item is Extract<ListItem, { kind: "project" }> => item.kind === "project" && item.project.work.id === project.work.id)?.row;
    const base = row ? actions.menuFor(row, x, y) : null;
    if (!base) return;
    // The app's work menu, with the navigator's own: 폴더로 옮기기, 바로가기, 단계, 태그.
    const items2: MenuEntry[] = base.items.map((entry) => (entry.kind === "submenu" && entry.label === "옮기기" ? moveMenu(works) : entry));
    const pinAt = items2.findIndex((entry) => entry.kind === "item" && (entry.label === "고정" || entry.label === "고정 풀기"));
    const extras = [shortcutEntry(works), stageMenu(works), tagEntry(works, x, y)];
    if (pinAt === -1) items2.push({ kind: "separator" }, ...extras);
    else items2.splice(pinAt + 1, 0, ...extras);
    actions.openMenu({ ...base, items: items2 });
  };

  // ── rows: clicks, keys, drags ───────────────────────────────────────────────────────────
  const focusRow = (id: string | null | undefined) => {
    if (!id) return;
    const from = document.activeElement;
    window.requestAnimationFrame(() => {
      // Not when the focus went somewhere else meanwhile (a rename box, the input of a project opened).
      const active = document.activeElement;
      if (active !== from && active !== document.body && !(active instanceof HTMLElement && active.matches("[data-list-row]"))) return;
      treeRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus();
    });
  };
  const step = (from: HTMLElement, offset: number | "first" | "last") => {
    const rows = [...(treeRef.current?.querySelectorAll<HTMLElement>("[data-list-row]") ?? [])];
    const index = rows.indexOf(from);
    const next = offset === "first" ? rows[0] : offset === "last" ? rows.at(-1) : rows[Math.max(0, Math.min(rows.length - 1, index + offset))];
    next?.focus();
    return next?.dataset.rowId ?? null;
  };
  const toggleOpen = (row: Extract<Row, { type: "work" }>) => {
    if (!row.expandable) return;
    const open = shared.open;
    const without = (list: string[]) => list.filter((id) => id !== row.id);
    shared.onOpenChange(row.open ? { ...open, openWorks: without(open.openWorks), closedWorks: [...without(open.closedWorks), row.id] } : { ...open, openWorks: [...without(open.openWorks), row.id], closedWorks: without(open.closedWorks) });
  };
  const latest = useRef<RowHandlers | null>(null);
  latest.current = {
    press: (event, project) => {
      if (event.button === 1 && actions.openRight) event.preventDefault();
      if (event.button !== 0 || shared.renaming) return;
      if ((event.target as HTMLElement).closest("input, .row-chevron, .row-add")) return;
      shared.press({ kind: "projects", works: chosenWorks(project.work) }, event);
    },
    click: (event, project) => {
      if (shared.justDragged()) return;
      const id = project.work.id;
      if (event.shiftKey) {
        const from = projectIds.indexOf(anchor ?? id);
        const to = projectIds.indexOf(id);
        if (from !== -1 && to !== -1) setSelected(projectIds.slice(Math.min(from, to), Math.max(from, to) + 1));
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        // Picking starts from the row last clicked (as in Notebook Navigator), not from what is on screen.
        const base = selected.length ? selected : anchor && anchor !== id && projectIds.includes(anchor) ? [anchor] : [];
        setSelected(base.includes(id) ? base.filter((entry) => entry !== id) : [...base, id]);
        setAnchor(id);
        return;
      }
      setSelected([]);
      setAnchor(id);
      actions.openWork(project.work);
    },
    aux: (event, project) => {
      if (event.button === 1) actions.openRight?.({ kind: "work", id: project.work.id });
    },
    menu: (event, project) => {
      event.preventDefault();
      event.stopPropagation();
      // A row outside the picked ones is a menu of its own.
      if (selected.length && !selected.includes(project.work.id)) setSelected([]);
      openMenu(project, event.clientX, event.clientY);
    },
    key: (event, project, row) => {
      const element = event.currentTarget;
      const id = project.work.id;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const next = step(element, event.key === "ArrowDown" ? 1 : -1);
        if (event.shiftKey && next && projectIds.includes(next)) {
          const from = projectIds.indexOf(anchor ?? id);
          const to = projectIds.indexOf(next);
          setSelected(projectIds.slice(Math.min(from, to), Math.max(from, to) + 1));
        }
      } else if (event.key === "Home") step(element, "first");
      else if (event.key === "End") step(element, "last");
      else if (event.key === "Enter") {
        setSelected([]);
        setAnchor(id);
        actions.openWork(project.work);
      } else if (event.key === "ArrowRight") {
        if (row.expandable && !row.open) toggleOpen(row);
        else if (row.open) step(element, 1);
      } else if (event.key === "ArrowLeft") {
        if (row.open) toggleOpen(row);
        else shared.focusNav();
      } else if (event.key === "F2") shared.setRenaming(id);
      else if (event.key === "Delete") archive(chosenWorks(project.work));
      else if (event.key === "Escape" && selected.length) setSelected([]);
      else if ((event.key === "a" || event.code === "KeyA") && (event.ctrlKey || event.metaKey)) setSelected(projectIds);
      else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
        const box = element.getBoundingClientRect();
        openMenu(project, box.left + 24, box.bottom - 4);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    },
    focus: (id) => setFocusId(id),
    toggle: toggleOpen,
    newPage: (work) => actions.newPage(work),
    rename: (work, name) => actions.rename({ kind: "work", id: work.id }, name),
    renameDone: (id) => {
      shared.setRenaming(null);
      focusRow(id || null);
    },
    startRename: (id) => shared.setRenaming(id),
  };
  // One object for every row (the rows compare it by identity); it calls the latest handlers.
  const handlers = useMemo<RowHandlers>(
    () => ({
      press: (event, project) => latest.current!.press(event, project),
      click: (event, project) => latest.current!.click(event, project),
      aux: (event, project) => latest.current!.aux(event, project),
      menu: (event, project) => latest.current!.menu(event, project),
      key: (event, project, row) => latest.current!.key(event, project, row),
      focus: (id) => latest.current!.focus(id),
      toggle: (row) => latest.current!.toggle(row),
      newPage: (work) => latest.current!.newPage(work),
      rename: (work, name) => latest.current!.rename(work, name),
      renameDone: (id) => latest.current!.renameDone(id),
      startRename: (id) => latest.current!.startRename(id),
    }),
    [],
  );

  // Sessions and documents of an unfolded project: the tree's rows, moving with the list's keys.
  const childCtx: RowContext = {
    ...shared.rowCtx,
    focusId,
    tabId,
    listRow: true,
    onFocusRow: (id) => setFocusId(id),
    onKey: (event, row) => {
      const element = event.currentTarget as HTMLElement;
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) return shared.rowCtx.onKey(event, row);
      if (event.key === "ArrowDown") step(element, 1);
      else if (event.key === "ArrowUp") step(element, -1);
      else if (event.key === "Home") step(element, "first");
      else if (event.key === "End") step(element, "last");
      else if (event.key === "ArrowLeft") {
        if (row.type === "docs" && row.open) shared.rowCtx.toggle(row);
        else if ("work" in row) focusRow(row.type === "doc" ? `docs:${row.work.id}` : row.work.id);
      } else if (event.key === "ArrowRight" && row.type === "docs" && !row.open) shared.rowCtx.toggle(row);
      else return shared.rowCtx.onKey(event, row);
      event.preventDefault();
      event.stopPropagation();
    },
    onRenameDone: (row) => {
      shared.setRenaming(null);
      focusRow(row.id);
    },
  };

  // ── the head ────────────────────────────────────────────────────────────────────────────
  const folder = selection.kind === "folder" ? state.folders[selection.id] : undefined;
  const title = selection.kind === "folder" ? (folder?.name ?? "프로젝트") : selection.kind === "tag" ? `#${selection.tag}` : selection.kind === "untagged" ? "태그 없음" : "프로젝트";
  const headIcon = selection.kind === "folder" ? (iconName(folder?.icon) ?? "folderOpen") : selection.kind === "tag" || selection.kind === "untagged" ? "hash" : "project";
  const subfolders = selection.kind === "root" || selection.kind === "folder";
  const key = selectionKey(selection);
  const own = nav.sortByFolder[key];
  const setSort = (next: { key: NavSortKey; desc: boolean }) => shared.saveNav({ sortByFolder: { ...nav.sortByFolder, [key]: next } });
  const sortMenu = (button: HTMLElement) => {
    const box = button.getBoundingClientRect();
    const [first, second] = DIRECTION[sort.key];
    const mixed = !subfolders || nav.includeSub;
    actions.openMenu({
      x: box.left,
      y: box.bottom + 4,
      title: `${title} 정렬`,
      items: [
        ...(Object.keys(SORT_LABEL) as NavSortKey[]).map((sortKey) => ({ kind: "item" as const, label: SORT_LABEL[sortKey], checked: sort.key === sortKey, onSelect: () => setSort({ key: sortKey, desc: sort.key === sortKey ? sort.desc : FIRST_DESC[sortKey] }) })),
        { kind: "separator" as const },
        { kind: "item" as const, label: first, checked: sort.desc === FIRST_DESC[sort.key], onSelect: () => setSort({ key: sort.key, desc: FIRST_DESC[sort.key] }) },
        { kind: "item" as const, label: second, checked: sort.desc !== FIRST_DESC[sort.key], onSelect: () => setSort({ key: sort.key, desc: !FIRST_DESC[sort.key] }) },
        { kind: "separator" as const },
        ...(own
          ? [
              {
                kind: "item" as const,
                label: `기본 정렬로 (${SORT_LABEL[nav.sortDefault.key]})`,
                icon: "restore" as const,
                onSelect: () => {
                  const { [key]: _dropped, ...rest } = nav.sortByFolder;
                  shared.saveNav({ sortByFolder: rest });
                },
              },
              {
                kind: "item" as const,
                label: "모든 목록의 기본으로",
                icon: "check" as const,
                onSelect: () => {
                  const { [key]: _dropped, ...rest } = nav.sortByFolder;
                  shared.saveNav({ sortDefault: sort, sortByFolder: rest });
                },
              },
            ]
          : nav.sortDefault.key !== DEFAULT_SORT.key || nav.sortDefault.desc !== DEFAULT_SORT.desc
            ? [{ kind: "item" as const, label: "처음 기본값으로 (최근 활동)", icon: "restore" as const, onSelect: () => shared.saveNav({ sortDefault: DEFAULT_SORT }) }]
            : [{ kind: "label" as const, label: "이 목록에만 적용됩니다" }]),
        { kind: "separator" as const },
        {
          kind: "submenu" as const,
          label: "줄 모양",
          icon: "list" as const,
          items: [
            { kind: "item" as const, label: "표준", checked: nav.density === "standard", onSelect: () => shared.saveNav({ density: "standard" }) },
            { kind: "item" as const, label: "촘촘히", checked: nav.density === "compact", onSelect: () => shared.saveNav({ density: "compact" }) },
            { kind: "separator" as const },
            ...([0, 1, 2, 3] as const).map((lines) => ({ kind: "item" as const, label: lines ? `미리보기 ${lines}줄` : "미리보기 없음", checked: nav.previewLines === lines, disabled: nav.density === "compact", onSelect: () => shared.saveNav({ previewLines: lines }) })),
          ],
        },
        ...(mixed
          ? [
              {
                kind: "submenu" as const,
                label: "묶기",
                icon: "grid" as const,
                items: [
                  { kind: "item" as const, label: "날짜별 (정렬대로)", checked: nav.groupSub === "date", onSelect: () => shared.saveNav({ groupSub: "date" }) },
                  { kind: "item" as const, label: "폴더별", checked: nav.groupSub === "folder", onSelect: () => shared.saveNav({ groupSub: "folder" }) },
                ],
              },
            ]
          : []),
      ],
    });
  };

  const rows = items.map((item) => {
    if (item.kind === "group") {
      return (
        <div key={`g:${item.key}`} className={`list-group${item.key === "pinned" ? " pinned" : ""}`} role="presentation">
          {item.key === "pinned" ? <Icon name="pin" size={12} /> : null}
          <span>{item.label}</span>
          <span className="count">{item.count}</span>
        </div>
      );
    }
    if (item.kind === "child") return <TreeRow key={item.row.id} row={item.row} ctx={childCtx} />;
    const { project } = item;
    const id = project.work.id;
    return (
      <ProjectRow
        key={id}
        project={project}
        folder={item.folder}
        row={item.row}
        stage={stages.find((stage) => stage.name === project.stage)}
        sortKey={sort.key}
        density={nav.density}
        previewLines={nav.previewLines}
        current={id === shared.currentWorkId && (!shared.visibleSessionId || !item.row.open)}
        selected={selected.includes(id)}
        focused={focusId === id}
        tab={id === tabId}
        renaming={shared.renaming === id}
        linkedId={(project.sessions.length === 1 ? project.sessions[0]! : item.row.open ? undefined : project.sessions.find((session) => linkOfSession(state, session.id)))?.id ?? null}
        handlers={handlers}
      />
    );
  });
  const anyProjects = shared.projects.length > 0;
  return (
    <div className="list-pane" aria-label="프로젝트 목록">
      <div className="list-head">
        <span className="list-title" title={title}>
          <span className="list-title-icon" style={folder?.color ? ({ "--folder-color": folder.color } as CSSProperties) : undefined}>
            <Icon name={headIcon} size={15} />
          </span>
          <span className="list-name">{title}</span>
          <span className="list-count">{count}</span>
        </span>
        <span className="list-tools">
          <button type="button" className="icon-button small" title={folder ? `「${folder.name}」에 새 프로젝트` : "새 프로젝트"} aria-label="새 프로젝트" onClick={() => actions.newSession({ folderId: folder ? folder.id : null })}>
            <Icon name="plus" size={14} />
          </button>
          {subfolders ? (
            <button
              type="button"
              className={`icon-button small${nav.includeSub ? " pressed" : ""}`}
              aria-pressed={nav.includeSub}
              title={nav.includeSub ? "하위 폴더의 프로젝트도 보는 중 (끄기)" : "하위 폴더의 프로젝트도 보기"}
              aria-label="하위 포함"
              onClick={() => shared.saveNav({ includeSub: !nav.includeSub })}
            >
              <Icon name="layers" size={14} />
            </button>
          ) : null}
          <button type="button" className="icon-button small" title={`정렬: ${SORT_LABEL[sort.key]} · 줄 모양`} aria-label="정렬과 줄 모양" aria-haspopup="menu" onClick={(event) => sortMenu(event.currentTarget)}>
            <Icon name="sort" size={14} />
          </button>
          <button
            type="button"
            className={`icon-button small${filterOpen || query ? " pressed" : ""}`}
            title="거르기 (이름 · #태그 · 단계:값 · 폴더:이름 · 속성:값)"
            aria-label="거르기"
            aria-pressed={filterOpen}
            onClick={() => {
              if (filterOpen) setQuery("");
              setFilterOpen(!filterOpen);
            }}
          >
            <Icon name="search" size={14} />
          </button>
        </span>
      </div>
      {filterOpen ? (
        <div className="list-filter">
          <input
            ref={filterInput}
            value={query}
            placeholder="이름 · #태그 · 단계:진행중"
            title="이름 낱말 · #태그 · 단계:값 · 폴더:이름 · 속성:값(마감일:2026-11) · 앞에 -는 빼기"
            aria-label="프로젝트 거르기"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
                setFilterOpen(false);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                treeRef.current?.querySelector<HTMLElement>("[data-list-row]")?.focus();
              }
            }}
          />
        </div>
      ) : null}
      <div className="list-scroll">
        <div className="side-tree list-rows" role="tree" aria-label={`${title} 프로젝트`} aria-multiselectable ref={treeRef}>
          {rows}
          {!count ? (
            <div className="empty-hint list-empty">
              {!anyProjects ? '아직 프로젝트가 없습니다. 위의 "새 세션"으로 시작하세요.' : query ? "거르기에 맞는 프로젝트가 없습니다." : selection.kind === "folder" ? "이 폴더에는 프로젝트가 없습니다. +로 만들거나 프로젝트를 이 폴더로 끌어 놓으세요." : "여기에는 프로젝트가 없습니다."}
            </div>
          ) : null}
          <LinkLines tree={treeRef} />
        </div>
      </div>
    </div>
  );
}
