import { Fragment, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Folder, NavSectionId, NavShortcut } from "@workbench/contracts";
import { folderHidden, nowSessions, workHidden, type Row } from "../../tree.ts";
import { EditableText } from "../EditableText.tsx";
import { Icon, iconName, type IconName } from "../Icon.tsx";
import type { MenuEntry } from "../ContextMenu.tsx";
import { useOptionalPkm } from "../pkm/PkmContext.tsx";
import { ViewsSection } from "../pkm/ViewsSection.tsx";
import { VaultSection } from "../pkm/VaultSection.tsx";
import { addShortcuts, countText, folderOrder, sameShortcut, type TagNode } from "./model.ts";
import { NowRow } from "./rows.tsx";
import type { NavShared } from "./shared.ts";

// The navigation pane: 홈, 지금, 바로가기, the project folders (the "프로젝트" root and folders only,
// no projects or sessions), the projects' tags, then the saved views and the vault as before. Every
// section head folds to its line and stays so (prefs `navigator.sections`).

const folderRowOf = (folder: Folder, depth = 0, open = true): Extract<Row, { type: "folder" }> => ({ type: "folder", id: folder.id, depth, folder, open, empty: false });

export const ROOT_ROW_ID = "nav:root";

/** A section's head: folds the section (the vault's one-line fold look), tools on the right. */
export function SectionHead({ id, label, shared, count, tools }: { id: NavSectionId; label: string; shared: NavShared; count?: string | number; tools?: ReactNode }) {
  const folded = Boolean(shared.nav.sections[id]);
  return (
    <div className="side-section-title with-tools nav-section-head">
      <button
        type="button"
        className="nav-fold"
        aria-expanded={!folded}
        title={folded ? `${label} 펼치기` : `${label} 접기`}
        onClick={() => shared.saveNav({ sections: { ...shared.nav.sections, [id]: !folded } })}
      >
        <Icon name={folded ? "chevronRight" : "chevronDown"} size={13} />
        <span>{label}</span>
      </button>
      {folded && count ? <span className="nav-fold-count">{count}</span> : null}
      {tools ? <span className="side-tools">{tools}</span> : null}
    </div>
  );
}

/** Insert entries before a menu's last group (its archive or delete items), or at its end. */
export function beforeLastGroup(items: MenuEntry[], extras: MenuEntry[]): MenuEntry[] {
  const at = items.map((entry) => entry.kind).lastIndexOf("separator");
  return at === -1 ? [...items, { kind: "separator" }, ...extras] : [...items.slice(0, at), { kind: "separator" }, ...extras, ...items.slice(at)];
}

/** ↑↓ through the pane's rows (in screen order), as the list and the vault do. */
function stepFocus(from: HTMLElement, step: 1 | -1 | "first" | "last") {
  const rows = [...(from.closest(".nav-pane")?.querySelectorAll<HTMLElement>("[data-nav-row]") ?? [])];
  const index = rows.indexOf(from);
  const next = step === "first" ? rows[0] : step === "last" ? rows.at(-1) : rows[index + step];
  next?.focus();
}

function folderIcon(folder: Folder, open: boolean): IconName {
  return iconName(folder.icon) ?? (open ? "folderOpen" : "folder");
}

export function HomeRow({ shared }: { shared: NavShared }) {
  return (
    <button type="button" className={`side-row side-home${shared.homeActive ? " current" : ""}`} onClick={shared.actions.openHome} title="모든 작업의 지금 상황과 새 세션">
      <Icon name="home" size={15} className="side-row-icon" />
      <span className="side-row-label">홈</span>
    </button>
  );
}

/** "지금": sessions waiting for the person, working, or with a new reply. */
export function NowSection({ shared }: { shared: NavShared }) {
  const { state, actions, visibleSessionId } = shared;
  const now = nowSessions(state, visibleSessionId);
  const groups = [
    { key: "attention", label: "확인 필요", sessions: now.attention },
    { key: "running", label: "진행 중", sessions: now.running },
    { key: "unseen", label: "새 답", sessions: now.unseen },
  ].filter((group) => group.sessions.length);
  if (!groups.length) return null;
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  const folded = Boolean(shared.nav.sections.now);
  return (
    <section className="side-section side-now" aria-label="지금">
      <SectionHead id="now" label="지금" shared={shared} count={total} />
      {folded
        ? null
        : groups.map((group) => (
            <div key={group.key} className={`now-group now-${group.key}`}>
              <div className="now-group-label">
                {group.label} <span className="count">{group.sessions.length}</span>
              </div>
              {group.sessions.map((session) => (
                <NowRow
                  key={session.id}
                  session={session}
                  label={`${state.works[session.workId]?.title ?? ""} — ${session.purpose}`}
                  current={session.id === visibleSessionId}
                  look={shared.lookOf(session.provider)}
                  onOpen={() => actions.openSession(session)}
                  onMenu={(x, y) => {
                    const work = state.works[session.workId];
                    if (work) shared.rowMenu({ type: "session", id: session.id, depth: 0, session, work }, x, y);
                  }}
                  openRight={actions.openRight}
                />
              ))}
            </div>
          ))}
      {!folded && now.running.length > 4 ? (
        <div className="now-memory" title="Claude·Codex 세션 하나가 엔진 프로세스로 약 250~350MB를 씁니다(이 노트북 측정). 막지는 않습니다.">
          동시에 {now.running.length}개 진행 중 · 메모리를 세션당 약 300MB 씁니다
        </div>
      ) : null}
    </section>
  );
}

type ShortcutView = { entry: NavShortcut; index: number; label: string; icon: IconName; color: string | null; current: boolean; disabled?: string; open: () => void };

/** "바로가기": projects, folders, tags, saved views and sessions, in the person's order. */
export function ShortcutsSection({ shared }: { shared: NavShared }) {
  const { state, actions, shortcuts } = shared;
  const pkm = useOptionalPkm();
  const [renamingAt, setRenamingAt] = useState<number | null>(null);
  const tree = shared.layout === "tree";
  const views: ShortcutView[] = [];
  shortcuts.forEach((entry, index) => {
    const base = { entry, index, color: null as string | null, current: false };
    if (entry.kind === "work") {
      const work = state.works[entry.id];
      if (!work || workHidden(state, work)) return;
      views.push({ ...base, label: entry.label ?? work.title, icon: "project", current: work.id === shared.currentWorkId, open: () => actions.openWork(work) });
    } else if (entry.kind === "session") {
      const session = state.sessions[entry.id];
      const work = session ? state.works[session.workId] : undefined;
      if (!session || session.archivedAt || !work || workHidden(state, work)) return;
      views.push({ ...base, label: entry.label ?? session.purpose, icon: "chat", current: session.id === shared.visibleSessionId, open: () => actions.openSession(session) });
    } else if (entry.kind === "folder") {
      const folder = state.folders[entry.id];
      if (!folder || folderHidden(state, folder.id)) return;
      const selected = shared.nav.selected.kind === "folder" && shared.nav.selected.id === folder.id;
      views.push({ ...base, label: entry.label ?? folder.name, icon: folderIcon(folder, false), color: folder.color ?? null, current: selected && !tree, open: () => shared.select({ kind: "folder", id: folder.id }) });
    } else if (entry.kind === "tag") {
      const selected = shared.nav.selected.kind === "tag" && shared.nav.selected.tag === entry.id;
      views.push({
        ...base,
        label: entry.label ?? `#${entry.id}`,
        icon: "tag",
        current: selected && !tree,
        disabled: tree ? "태그 목록은 두 칸·위아래 배치에서 고를 수 있습니다." : undefined,
        open: () => shared.select({ kind: "tag", tag: entry.id }),
      });
    } else if (entry.kind === "view") {
      const view = pkm?.pkmState?.views.find((candidate) => candidate.id === entry.id);
      if (!view) return;
      views.push({ ...base, label: entry.label ?? view.name, icon: "grid", current: pkm?.target?.kind === "view" && pkm.target.id === view.id, open: () => pkm?.open?.({ kind: "view", id: view.id }) });
    }
  });
  const folded = Boolean(shared.nav.sections.shortcuts);
  const remove = (index: number) => shared.saveShortcuts(shortcuts.filter((_, at) => at !== index));
  const relabel = (index: number, label: string | null) => shared.saveShortcuts(shortcuts.map((entry, at) => (at === index ? (label ? { ...entry, label } : { kind: entry.kind, id: entry.id }) : entry)));
  const menu = (view: ShortcutView, x: number, y: number) =>
    actions.openMenu({
      x,
      y,
      title: view.label,
      items: [
        { kind: "item", label: "열기", icon: view.icon, disabled: Boolean(view.disabled), onSelect: view.open },
        ...(view.entry.kind === "work" && actions.openRight ? [{ kind: "item" as const, label: "오른쪽에 열기", icon: "columns" as const, onSelect: () => actions.openRight!({ kind: "work", id: view.entry.id }) }] : []),
        { kind: "item", label: "이름표 바꾸기", icon: "edit", hint: "F2", onSelect: () => setRenamingAt(view.index) },
        ...(view.entry.label ? [{ kind: "item" as const, label: "원래 이름으로", icon: "restore" as const, onSelect: () => relabel(view.index, null) }] : []),
        { kind: "separator" },
        { kind: "item", label: "바로가기에서 빼기", icon: "x", hint: "Delete", onSelect: () => remove(view.index) },
      ],
    });
  const onKey = (event: ReactKeyboardEvent<HTMLElement>, view: ShortcutView) => {
    const element = event.currentTarget;
    if (event.key === "ArrowDown") stepFocus(element, 1);
    else if (event.key === "ArrowUp") stepFocus(element, -1);
    else if (event.key === "Enter" && !view.disabled) view.open();
    else if (event.key === "ArrowRight" && !tree) shared.focusList();
    else if (event.key === "F2") setRenamingAt(view.index);
    else if (event.key === "Delete") remove(view.index);
    else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      const box = element.getBoundingClientRect();
      menu(view, box.left + 24, box.bottom - 4);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <section className="side-section nav-shortcuts" aria-label="바로가기" data-drop-shortcuts="">
      <SectionHead id="shortcuts" label="바로가기" shared={shared} count={views.length || undefined} />
      {folded ? null : views.length ? (
        <div role="list" aria-label="바로가기">
          {views.map((view) =>
            renamingAt === view.index ? (
              <div key={`${view.entry.kind}:${view.entry.id}`} className="side-row renaming nav-shortcut" data-shortcut-index={view.index}>
                <Icon name={view.icon} size={15} className="side-row-icon" />
                <EditableText className="side-rename" value={view.label} onSave={(next) => relabel(view.index, next)} onDone={() => setRenamingAt(null)} />
              </div>
            ) : (
              <div
                key={`${view.entry.kind}:${view.entry.id}`}
                role="listitem"
                tabIndex={-1}
                className={`side-row nav-shortcut${view.current ? " current" : ""}${view.disabled ? " disabled" : ""}`}
                data-nav-row=""
                data-shortcut-index={view.index}
                data-shortcut-kind={view.entry.kind}
                data-shortcut-id={view.entry.id}
                title={view.disabled ?? (view.entry.label ? `원래 이름: ${view.entry.kind === "tag" ? `#${view.entry.id}` : view.label}` : undefined)}
                onPointerDown={(event) => {
                  if ((event.target as HTMLElement).closest(".nav-shortcut-remove")) return;
                  shared.press({ kind: "shortcut", index: view.index, entry: view.entry, label: view.label }, event);
                }}
                onClick={() => {
                  if (shared.justDragged() || view.disabled) return;
                  view.open();
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  menu(view, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => onKey(event, view)}
              >
                <span className="side-row-icon nav-shortcut-icon" style={view.color ? ({ "--folder-color": view.color } as CSSProperties) : undefined}>
                  <Icon name={view.icon} size={15} />
                </span>
                <span className="side-row-label">{view.label}</span>
                <button
                  type="button"
                  className="row-add nav-shortcut-remove"
                  title="바로가기에서 빼기"
                  aria-label={`${view.label} 바로가기에서 빼기`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(view.index);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            ),
          )}
        </div>
      ) : (
        <div className="nav-empty">프로젝트·폴더·태그를 여기로 끌어 놓으면 바로가기가 됩니다.</div>
      )}
    </section>
  );
}

/** "프로젝트": the root (projects outside any folder) and the folder tree, folders only. */
export function ProjectsSection({ shared }: { shared: NavShared }) {
  const { state, actions, nav, counts, open } = shared;
  const [folderName, setFolderName] = useState("");
  const folded = Boolean(nav.sections.projects);
  const closed = new Set(open.closedFolders);
  const all = folderOrder(state.folders, null);
  const visible: { folder: Folder; depth: number; open: boolean; children: boolean }[] = [];
  let hiddenBelow: number | null = null;
  for (const { folder, depth } of all) {
    if (hiddenBelow !== null && depth > hiddenBelow) continue;
    hiddenBelow = null;
    const children = all.some((entry) => entry.folder.parentId === folder.id);
    const isOpen = children && !closed.has(folder.id);
    visible.push({ folder, depth, open: isOpen, children });
    if (!isOpen) hiddenBelow = depth;
  }
  const selected = nav.selected;
  const isSelected = (folderId: string | null) => (folderId === null ? selected.kind === "root" : selected.kind === "folder" && selected.id === folderId);
  const tabbable = selected.kind === "root" || selected.kind === "folder" ? (selected.kind === "folder" ? selected.id : ROOT_ROW_ID) : null;
  const toggle = (folderId: string, isOpen: boolean) => {
    const next = new Set(open.closedFolders);
    if (isOpen) next.add(folderId);
    else next.delete(folderId);
    shared.onOpenChange({ ...open, closedFolders: [...next] });
  };
  const folderMenu = (folder: Folder, x: number, y: number) => shared.rowMenu(folderRowOf(folder), x, y);
  const rootMenu = (x: number, y: number) =>
    actions.openMenu({
      x,
      y,
      title: "프로젝트",
      items: [
        { kind: "item", label: "새 프로젝트", icon: "plus", onSelect: () => actions.newSession({ folderId: null }) },
        { kind: "item", label: "새 폴더", icon: "folder", onSelect: () => shared.setCreatingIn(null) },
      ],
    });
  const onKey = (event: ReactKeyboardEvent<HTMLElement>, folder: Folder | null, isOpen: boolean, children: boolean) => {
    const element = event.currentTarget;
    if (event.key === "ArrowDown") stepFocus(element, 1);
    else if (event.key === "ArrowUp") stepFocus(element, -1);
    else if (event.key === "Home") stepFocus(element, "first");
    else if (event.key === "End") stepFocus(element, "last");
    else if (event.key === "ArrowRight") {
      if (folder && children && !isOpen) toggle(folder.id, false);
      else shared.focusList();
    } else if (event.key === "ArrowLeft") {
      if (folder && children && isOpen) toggle(folder.id, true);
      else if (folder) element.closest(".nav-folder-tree")?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(folder.parentId && state.folders[folder.parentId] ? folder.parentId : ROOT_ROW_ID)}"]`)?.focus();
    } else if (event.key === "Enter") shared.select(folder ? { kind: "folder", id: folder.id } : { kind: "root" });
    else if (event.key === "F2" && folder) shared.setRenaming(folder.id);
    else if (event.key === "Delete" && folder) actions.archive({ kind: "folder", id: folder.id });
    else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      const box = element.getBoundingClientRect();
      if (folder) folderMenu(folder, box.left + 24, box.bottom - 4);
      else rootMenu(box.left + 24, box.bottom - 4);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const creatingRow = (depth: number) => (
    <form
      className="side-row creating"
      style={{ paddingLeft: 8 + depth * 14 }}
      onSubmit={(event) => {
        event.preventDefault();
        const name = folderName.trim();
        if (!name) return;
        const parentId = shared.creatingIn ?? null;
        void actions.createFolder(name, parentId).then(() => {
          shared.setCreatingIn(undefined);
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
        aria-label="새 폴더 이름"
        onChange={(event) => setFolderName(event.target.value)}
        onBlur={() => !folderName.trim() && shared.setCreatingIn(undefined)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            shared.setCreatingIn(undefined);
            setFolderName("");
          }
        }}
      />
    </form>
  );
  const root = counts.root;
  return (
    <section className="side-section nav-projects" aria-label="프로젝트">
      <SectionHead
        id="projects"
        label="프로젝트"
        shared={shared}
        count={countText(root)}
        tools={
          <button type="button" className="icon-button small" title="새 폴더" aria-label="새 폴더" onClick={() => shared.setCreatingIn(null)}>
            <Icon name="plus" size={13} />
          </button>
        }
      />
      {folded ? null : (
        <div className="nav-folder-tree" role="tree" aria-label="프로젝트 폴더">
          <div
            role="treeitem"
            aria-level={1}
            aria-selected={isSelected(null)}
            tabIndex={tabbable === ROOT_ROW_ID ? 0 : -1}
            className={`side-row nav-root${isSelected(null) ? " current" : ""}`}
            style={{ paddingLeft: 8 }}
            data-row-id={ROOT_ROW_ID}
            data-nav-row=""
            data-nav-folder=""
            title={`폴더 밖 ${root.own}개 · 폴더 안 ${root.below}개`}
            onClick={() => !shared.justDragged() && shared.select({ kind: "root" })}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              rootMenu(event.clientX, event.clientY);
            }}
            onKeyDown={(event) => onKey(event, null, true, false)}
          >
            <span className="row-chevron blank" />
            <Icon name="project" size={15} className="side-row-icon" />
            <span className="side-row-label">프로젝트</span>
            <span className="side-row-trail muted nav-count">{countText(root)}</span>
          </div>
          {shared.creatingIn === null ? creatingRow(0) : null}
          {visible.map(({ folder, depth, open: isOpen, children }) => {
            const count = counts.folders.get(folder.id);
            const style = { paddingLeft: 8 + depth * 14, ...(folder.color ? { "--folder-color": folder.color } : {}) } as CSSProperties;
            return (
              <Fragment key={folder.id}>
                {shared.renaming === folder.id ? (
                  <div className="side-row renaming nav-folder" style={style} data-row-id={folder.id}>
                    <span className="row-chevron blank" />
                    <Icon name={folderIcon(folder, isOpen)} size={15} />
                    <EditableText
                      className="side-rename"
                      value={folder.name}
                      onSave={(next) => actions.rename({ kind: "folder", id: folder.id }, next)}
                      onDone={() => {
                        shared.setRenaming(null);
                        window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`.nav-folder-tree [data-row-id="${CSS.escape(folder.id)}"]`)?.focus());
                      }}
                    />
                  </div>
                ) : (
                  <div
                    role="treeitem"
                    aria-level={depth + 2}
                    aria-expanded={children ? isOpen : undefined}
                    aria-selected={isSelected(folder.id)}
                    tabIndex={tabbable === folder.id ? 0 : -1}
                    className={`side-row nav-folder${isSelected(folder.id) ? " current" : ""}${folder.color ? " colored" : ""}`}
                    style={style}
                    data-row-id={folder.id}
                    data-nav-row=""
                    data-nav-folder=""
                    title={`${folder.name} · 이 폴더 ${count?.own ?? 0}개${count?.below ? ` · 하위 ${count.below}개` : ""}`}
                    onPointerDown={(event) => {
                      if ((event.target as HTMLElement).closest(".row-chevron")) return;
                      shared.press({ kind: "row", row: folderRowOf(folder, depth, isOpen) }, event);
                    }}
                    onClick={(event) => {
                      if (shared.justDragged()) return;
                      if ((event.button === 1 || event.ctrlKey || event.metaKey) && actions.openRight) actions.openRight({ kind: "folder", id: folder.id });
                      else shared.select({ kind: "folder", id: folder.id });
                    }}
                    onAuxClick={(event) => event.button === 1 && actions.openRight?.({ kind: "folder", id: folder.id })}
                    onDoubleClick={() => shared.setRenaming(folder.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      folderMenu(folder, event.clientX, event.clientY);
                    }}
                    onKeyDown={(event) => onKey(event, folder, isOpen, children)}
                  >
                    <span
                      className={`row-chevron${children ? "" : " blank"}`}
                      onClick={(event) => {
                        if (!children) return;
                        event.stopPropagation();
                        toggle(folder.id, isOpen);
                      }}
                      aria-hidden
                    >
                      {children ? <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={13} /> : null}
                    </span>
                    <span className="side-row-icon nav-folder-icon">
                      <Icon name={folderIcon(folder, isOpen)} size={15} />
                    </span>
                    <span className="side-row-label">{folder.name}</span>
                    <span className="side-row-trail muted nav-count">{countText(count)}</span>
                  </div>
                )}
                {shared.creatingIn === folder.id ? creatingRow(depth + 1) : null}
              </Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** "태그": the projects' note tags as a tree split on "/", with "태그 없음". */
export function TagsSection({ shared }: { shared: NavShared }) {
  const { nodes, untagged } = shared.tags;
  if (!nodes.length) return null;
  const folded = Boolean(shared.nav.sections.tags);
  const opened = new Set(shared.nav.openTags);
  const selected = shared.nav.selected;
  const toggle = (tag: string) => {
    const next = new Set(opened);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    shared.saveNav({ openTags: [...next] });
  };
  const inShortcuts = (tag: string) => shared.shortcuts.some((entry) => sameShortcut(entry, { kind: "tag", id: tag }));
  const menu = (tag: string, x: number, y: number) =>
    shared.actions.openMenu({
      x,
      y,
      title: `#${tag}`,
      items: [
        { kind: "item", label: "이 태그의 프로젝트", icon: "tag", onSelect: () => shared.select({ kind: "tag", tag }) },
        inShortcuts(tag)
          ? { kind: "item", label: "바로가기에서 빼기", icon: "star", onSelect: () => shared.saveShortcuts(shared.shortcuts.filter((entry) => !sameShortcut(entry, { kind: "tag", id: tag }))) }
          : { kind: "item", label: "바로가기에 더하기", icon: "star", onSelect: () => shared.saveShortcuts(addShortcuts(shared.shortcuts, [{ kind: "tag", id: tag }])) },
      ],
    });
  const onKey = (event: ReactKeyboardEvent<HTMLElement>, node: TagNode | null) => {
    const element = event.currentTarget;
    const isOpen = node ? opened.has(node.tag) : false;
    if (event.key === "ArrowDown") stepFocus(element, 1);
    else if (event.key === "ArrowUp") stepFocus(element, -1);
    else if (event.key === "ArrowRight") {
      if (node?.children.length && !isOpen) toggle(node.tag);
      else shared.focusList();
    } else if (event.key === "ArrowLeft" && node?.children.length && isOpen) toggle(node.tag);
    else if (event.key === "Enter") shared.select(node ? { kind: "tag", tag: node.tag } : { kind: "untagged" });
    else if (((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") && node) {
      const box = element.getBoundingClientRect();
      menu(node.tag, box.left + 24, box.bottom - 4);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const rows: ReactNode[] = [];
  const walk = (list: TagNode[], depth: number) => {
    for (const node of list) {
      const isOpen = opened.has(node.tag);
      const current = selected.kind === "tag" && selected.tag.toLocaleLowerCase("ko") === node.tag.toLocaleLowerCase("ko");
      rows.push(
        <div
          key={node.tag}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={node.children.length ? isOpen : undefined}
          aria-selected={current}
          tabIndex={current ? 0 : -1}
          className={`side-row nav-tag${current ? " current" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-nav-row=""
          data-tag={node.tag}
          title={`#${node.tag} · ${node.count}개`}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest(".row-chevron")) return;
            shared.press({ kind: "tag", tag: node.tag }, event);
          }}
          onClick={() => !shared.justDragged() && shared.select({ kind: "tag", tag: node.tag })}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            menu(node.tag, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => onKey(event, node)}
        >
          <span
            className={`row-chevron${node.children.length ? "" : " blank"}`}
            onClick={(event) => {
              if (!node.children.length) return;
              event.stopPropagation();
              toggle(node.tag);
            }}
            aria-hidden
          >
            {node.children.length ? <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={13} /> : null}
          </span>
          <Icon name="hash" size={14} className="side-row-icon" />
          <span className="side-row-label">{node.name}</span>
          <span className="side-row-trail muted nav-count">{node.count}</span>
        </div>,
      );
      if (isOpen) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  const untaggedCurrent = selected.kind === "untagged";
  return (
    <section className="side-section nav-tags" aria-label="태그">
      <SectionHead id="tags" label="태그" shared={shared} count={nodes.length} />
      {folded ? null : (
        <div role="tree" aria-label="태그">
          {rows}
          {untagged ? (
            <div
              role="treeitem"
              aria-level={1}
              aria-selected={untaggedCurrent}
              tabIndex={untaggedCurrent ? 0 : -1}
              className={`side-row nav-tag nav-untagged${untaggedCurrent ? " current" : ""}`}
              style={{ paddingLeft: 8 }}
              data-nav-row=""
              onClick={() => shared.select({ kind: "untagged" })}
              onKeyDown={(event) => onKey(event, null)}
            >
              <span className="row-chevron blank" />
              <Icon name="hash" size={14} className="side-row-icon" />
              <span className="side-row-label">태그 없음</span>
              <span className="side-row-trail muted nav-count">{untagged}</span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** The navigation pane as a whole (two-pane and stacked layouts). */
export function NavPane({ shared }: { shared: NavShared }) {
  return (
    <div className="nav-pane side-scroll" aria-label="탐색">
      <HomeRow shared={shared} />
      <NowSection shared={shared} />
      <ShortcutsSection shared={shared} />
      <ProjectsSection shared={shared} />
      <TagsSection shared={shared} />
      <ViewsSection
        openMenu={shared.actions.openMenu}
        folded={Boolean(shared.nav.sections.views)}
        onFold={(folded) => shared.saveNav({ sections: { ...shared.nav.sections, views: folded } })}
        menuExtras={(view) => [viewShortcutEntry(shared, view.id)]}
      />
      <VaultSection theme={shared.theme} openMenu={shared.actions.openMenu} />
    </div>
  );
}

/** "바로가기에 더하기/빼기" for a saved view (its menu lives with the views). */
export function viewShortcutEntry(shared: NavShared, id: string): MenuEntry {
  const entry = { kind: "view" as const, id };
  return shared.shortcuts.some((other) => sameShortcut(other, entry))
    ? { kind: "item", label: "바로가기에서 빼기", icon: "star", onSelect: () => shared.saveShortcuts(shared.shortcuts.filter((other) => !sameShortcut(other, entry))) }
    : { kind: "item", label: "바로가기에 더하기", icon: "star", onSelect: () => shared.saveShortcuts(addShortcuts(shared.shortcuts, [entry])) };
}
