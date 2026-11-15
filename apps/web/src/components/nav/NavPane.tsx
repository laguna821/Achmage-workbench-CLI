import { useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Folder, NavSectionId, NavShortcut } from "@workbench/contracts";
import { folderHidden, nowSessions, workHidden } from "../../tree.ts";
import { EditableText } from "../EditableText.tsx";
import { Icon, iconName, type IconName } from "../Icon.tsx";
import type { MenuEntry } from "../ContextMenu.tsx";
import { useOptionalPkm } from "../pkm/PkmContext.tsx";
import { addShortcuts, sameShortcut, type TagNode } from "./model.ts";
import { NowRow } from "./rows.tsx";
import type { NavShared } from "./shared.ts";
import { StateMark } from "../StateMark.tsx";
import { ROW_STATES } from "../../row-state.ts";

// Sections the list column shares (N1): 지금 (in 활동), 바로가기 and 태그 (in level 1), each head
// folding to its line and staying so (prefs `navigator.sections`). 홈 became the rail's 지금, the
// folder pane became level 1's folders (nav/ProjectsLevel.tsx).

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
                <StateMark state={ROW_STATES[group.key === "attention" ? "attention" : group.key === "running" ? "running" : "unseen"]} size={14} />
                {group.label} <span className="count">{group.sessions.length}</span>
              </div>
              {/* Home lists these in full (the entries and the ledger): beside it the sidebar keeps only the counts. */}
              {shared.homeOwnsNow ? null : group.sessions.map((session) => (
                <NowRow
                  key={session.id}
                  session={session}
                  label={session.purpose}
                  meta={state.works[session.workId]?.title}
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
        <div className="now-memory" title="Claude나 Codex 대화 하나가 약 250~350MB를 씁니다(이 노트북에서 잰 값). 막지는 않습니다.">
          동시에 {now.running.length}개 진행 중입니다. 대화마다 메모리를 약 300MB 씁니다.
        </div>
      ) : null}
    </section>
  );
}

type ShortcutView = { entry: NavShortcut; index: number; label: string; icon: IconName; color: string | null; current: boolean; /** Selected as what the list shows (a folder, a tag). */ scope?: boolean; disabled?: string; open: () => void };

/** What the list pane lists (a folder, a tag): marked apart from the project on screen. */
const scopeMark = (selected: boolean) => (selected ? { "data-scope": "" } : {});

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
      views.push({ ...base, label: entry.label ?? folder.name, icon: folderIcon(folder, false), color: folder.color ?? null, scope: selected && !tree, open: () => shared.select({ kind: "folder", id: folder.id }) });
    } else if (entry.kind === "tag") {
      const selected = shared.nav.selected.kind === "tag" && shared.nav.selected.tag === entry.id;
      views.push({
        ...base,
        label: entry.label ?? `#${entry.id}`,
        icon: "tag",
        scope: selected && !tree,
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
      <SectionHead id="shortcuts" label="바로가기" shared={shared} count={views.length || undefined} tools={views.length ? undefined : <span className="nav-empty-hint" title={`${tree ? "프로젝트·폴더를" : "프로젝트·폴더·태그를"} 여기로 끌어 놓거나, 메뉴의 "바로가기에 더하기"로 더합니다.`}>끌어 놓아 더하기</span>} />
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
                {...scopeMark(Boolean(view.scope))}
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
        // N1: an empty 바로가기 is its head line only (still the place to drop onto); the hint is its title.
        null
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
          className="side-row nav-tag"
          {...scopeMark(current)}
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
              className="side-row nav-tag nav-untagged"
              {...scopeMark(untaggedCurrent)}
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

/** "바로가기에 더하기/빼기" for a saved view (its menu lives with the views). */
export function viewShortcutEntry(shared: NavShared, id: string): MenuEntry {
  const entry = { kind: "view" as const, id };
  return shared.shortcuts.some((other) => sameShortcut(other, entry))
    ? { kind: "item", label: "바로가기에서 빼기", icon: "star", onSelect: () => shared.saveShortcuts(shared.shortcuts.filter((other) => !sameShortcut(other, entry))) }
    : { kind: "item", label: "바로가기에 더하기", icon: "star", onSelect: () => shared.saveShortcuts(addShortcuts(shared.shortcuts, [entry])) };
}
