import { MESSENGER_HOME_TITLE, withParticle } from "@workbench/contracts";
import { AUTO_NAME_HINT, EditableText } from "../EditableText.tsx";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ItemIcon } from "../ItemIcon.tsx";
import type { NavSectionId, Work } from "@workbench/contracts";
import { workPages, type Row } from "../../tree.ts";
import { Icon } from "../Icon.tsx";
import { folderPath, insideSections } from "./model.ts";
import { TreeRow, leadAgentState, rowLabel, sessionState, type RowContext } from "./rows.tsx";
import { leadState } from "../../row-state.ts";
import { LinkLines } from "../LinkSidebar.tsx";
import type { NavShared } from "./shared.ts";
import { ListEmpty } from "./Lists.tsx";
import { LIST_STOP, typeAhead } from "./focus.ts";
import { WebRows } from "./WebRows.tsx";
import { InsideSection } from "./InsideSection.tsx";
import { LIST_SHOWN, MoreRows, capRows } from "./Lists.tsx";

// Level 2 of the list column (N1): inside one project. "← 프로젝트 목록" goes back to every project
// (the list only: the tabs, the panes and the running AI stay); the folder path and the project's
// name; its project note pinned first; "현재 프로젝트에서 찾기"; then 대화 N · 문서 N · 웹 N as
// sections that fold, each with a + that adds into this project. Rows are the tree's rows (same
// `data-row-id`, menus, keys and drags) and say their state in words or their kind.

export const BACK_LABEL = "프로젝트 목록";

export function ProjectLevel({ shared, work, query, setQuery, onBack }: {
  shared: NavShared;
  work: Work;
  query: string;
  setQuery: (query: string) => void;
  onBack: () => void;
}) {
  const { state, actions, nav } = shared;
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [fieldOpen, setFieldOpen] = useState(false);
  const showField = fieldOpen || Boolean(query);
  const sections = useMemo(() => insideSections(state, work), [state, work]);
  const text = query.trim().toLocaleLowerCase("ko");
  const match = (row: Row) => !text || rowLabel(row).toLocaleLowerCase("ko").includes(text);
  const path = folderPath(state.folders, work.folderId);
  const noteHere = shared.currentWorkId === work.id && !shared.visibleSessionId && !shared.currentDocId;

  const step = (from: HTMLElement, offset: number | "first" | "last") => {
    const rows = [...(list.current?.closest(".nav-level")?.querySelectorAll<HTMLElement>(LIST_STOP) ?? [])];
    const index = rows.indexOf(from);
    if (offset === -1 && index === 0) { field.current?.focus(); return; }
    const next = offset === "first" ? rows[0] : offset === "last" ? rows.at(-1) : rows[Math.max(0, Math.min(rows.length - 1, index + offset))];
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
  };
  // Keys inside: ↑↓ Home End move, Alt+← goes back to every project, the rest as the tree's rows.
  const onKey = (event: ReactKeyboardEvent, row: Row | null) => {
    const element = event.currentTarget as HTMLElement;
    if (event.altKey && event.key === "ArrowLeft") onBack();
    else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) return row ? shared.rowCtx.onKey(event, row) : undefined;
    else if (event.key === "ArrowDown") step(element, 1);
    else if (event.key === "ArrowUp") step(element, -1);
    else if (event.key === "Home") step(element, "first");
    else if (event.key === "End") step(element, "last");
    else if (typeAhead(event)) { /* moved to the row whose name starts with what was typed */ }
    else if (row) return shared.rowCtx.onKey(event, row);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const [allIn, setAllIn] = useState<Partial<Record<string, boolean>>>({});
  const ctx: RowContext = { ...shared.rowCtx, words: true, listRow: true, onKey, tabId: shared.rowCtx.focusId ?? shared.visibleSessionId ?? shared.currentDocId ?? sections.chats[0]?.id ?? null };

  // 불러오기 (hangul-convert): "문서 불러오기…" in the 문서 head, and files dropped from the computer onto 문서.
  const importDocuments = actions.importDocuments;
  const docTools = importDocuments ? <button type="button" className="icon-button small nav-inside-import" aria-label="문서 불러오기…" title="문서 불러오기… (한글·워드·엑셀 파일을 이 프로젝트로 복사해 Markdown으로 변환)" aria-haspopup="dialog" onClick={() => importDocuments(work)}><Icon name="download" size={14} /></button> : null;
  const section = (id: Extract<NavSectionId, "chats" | "docs" | "web">, label: string, rows: Row[], add: (anchor: HTMLButtonElement) => void, addLabel: string): ReactNode => {
    const folded = Boolean(nav.sections[id]);
    // About 100 rows, then "N개 더 보기" (tech review P1); the row on screen always shows; finding searches all.
    const { shown, hidden } = capRows(rows.filter(match), LIST_SHOWN, Boolean(allIn[id]), (row) => row.id === shared.visibleSessionId || row.id === shared.currentDocId);
    // Folded, a section still says where the person is and its most pressing state (as the 문서 row did).
    const lead = leadState(rows, (row) => {
      const state = row.type === "session" ? sessionState(row.session, shared.visibleSessionId) : row.type === "doc" ? (leadAgentState(row.agents, shared.visibleSessionId)?.state ?? null) : null;
      return state && state.id !== "done" && state.id !== "queued" ? state : null;
    })?.state ?? null;
    const here = folded && rows.some((row) => row.id === shared.visibleSessionId || row.id === shared.currentDocId);
    return (
      <InsideSection key={id} id={id} label={label} count={rows.length} folded={folded} here={here} lead={lead}
        onFold={() => shared.saveNav({ sections: { ...nav.sections, [id]: !folded } })}
        addLabel={addLabel} addMenu={id !== "chats"} onAdd={add}
        {...(id === "docs" && importDocuments ? { tools: docTools, onFiles: (files: File[]) => importDocuments(work, files) } : {})}
        empty={text ? "찾는 이름이 없습니다." : rows.length ? null : `아직 ${label === "웹" ? "웹 페이지가" : `${withParticle(`${label}`, "이/가")}`} 없습니다.`}>
        {shown.length ? <>{shown.map((row) => <TreeRow key={row.id} row={row} ctx={ctx} />)}<MoreRows what={label === "웹" ? "웹 페이지" : label} hidden={hidden} onShow={() => setAllIn((current) => ({ ...current, [id]: true }))} onKey={(event) => onKey(event, null)} /></> : null}
      </InsideSection>
    );
  };
  const creation = (anchor: HTMLButtonElement) => {
    const box = anchor.getBoundingClientRect();
    if (actions.creationMenu) actions.creationMenu(work, box.left, box.bottom);
    else actions.newPage(work);
  };
  // Skin 2 · B: the 웹 section lists the project's pages when the app gives them (else its page AIs, as before).
  const web = actions.web && typeof actions.web === "object" ? actions.web : null;
  const workRow: Row = { type: "work", id: work.id, depth: 0, work, open: true, expandable: false, sessions: [], docs: [] };
  const menuAt = (x: number, y: number) => shared.rowMenu(workRow, x, y);

  return (
    <div className="nav-level nav-level-two" data-level="project" data-project-id={work.id}>
      <div className="nav-head nav-head-inside">
        <button type="button" className="ghost-button small nav-back" onClick={onBack} title="프로젝트 목록으로 (Alt+←). 열린 탭과 AI 실행은 그대로입니다." aria-label={`${BACK_LABEL}으로`}>
          <Icon name="chevronLeft" size={16} />
          <span>{BACK_LABEL}</span>
        </button>
        <span className="nav-head-tools">
          <button type="button" className={`icon-button small nav-find${showField ? " pressed" : ""}`} aria-label="현재 프로젝트에서 찾기" aria-expanded={showField} title="현재 프로젝트에서 찾기 (Ctrl+F)" onClick={() => {
            if (fieldOpen && !query) setFieldOpen(false);
            else { setFieldOpen(true); window.requestAnimationFrame(() => field.current?.focus()); }
          }}>
            <Icon name="search" size={16} />
          </button>
          <button type="button" className="icon-button small" aria-label={`${work.title} 메뉴`} title="프로젝트 메뉴" aria-haspopup="menu" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); menuAt(box.left, box.bottom + 4); }}>
            <Icon name="dots" size={16} />
          </button>
        </span>
      </div>
      <div className="nav-project-head" onContextMenu={(event) => { event.preventDefault(); menuAt(event.clientX, event.clientY); }}>
        {/* 이름 바꾸기 asked here (its ⋯, a tab's menu) renames in place: the list stays inside the project. */}
        {shared.renaming === work.id
          ? <EditableText className="side-rename nav-project-name-edit" label={`${work.title} 이름 바꾸기`} value={work.title}
              empty={work.messengerHome ? { hint: MESSENGER_HOME_TITLE[work.messengerHome.kind], restores: MESSENGER_HOME_TITLE[work.messengerHome.kind] } : { hint: AUTO_NAME_HINT }}
              onSave={(next) => actions.rename({ kind: "work", id: work.id }, next)} onDone={() => shared.setRenaming(null)} />
          : <h2 className="nav-project-name" title={work.title} onDoubleClick={() => shared.setRenaming(work.id)}>{work.title}</h2>}
        {path ? <div className="nav-path" title={path}>{path}</div> : null}
      </div>
      <div
        role="button"
        tabIndex={0}
        className={`side-row nav-note${noteHere ? " current" : ""}`}
        data-list-row=""
        data-note-id={work.id}
        aria-current={noteHere ? "page" : undefined}
        title="프로젝트 노트: 목표, 결정, 속성"
        onClick={() => actions.openWork(work)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); actions.openWork(work); } else onKey(event, null); }}
      >
        <ItemIcon kind="project" size={15} className="side-row-icon" />
        <span className="side-row-label">프로젝트 노트</span>
      </div>
      {showField ? <label className="nav-field">
        <Icon name="search" size={14} />
        <input
          ref={field}
          value={query}
          placeholder="현재 프로젝트에서 찾기"
          aria-label="현재 프로젝트에서 찾기"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (query) setQuery(""); else setFieldOpen(false); }
            else if (event.key === "ArrowDown") { event.preventDefault(); list.current?.querySelector<HTMLElement>("[data-list-row]")?.focus(); }
            else if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); onBack(); }
          }}
        />
      </label> : null}
      <div className="nav-scroll side-scroll" ref={list}>
        {!sections.chats.length && !sections.docs.length && !(web ? workPages(state, work.id, web).length : sections.web.length) && !text ? <ListEmpty line="이 프로젝트에는 아직 대화도 문서도 없습니다." action="새 대화" onAction={() => actions.newSession({ work })} /> : null}
        {section("chats", "대화", sections.chats, () => actions.newSession({ work }), "이 프로젝트에 새 대화")}
        {section("docs", "문서", sections.docs, creation, "이 프로젝트에 새 문서")}
        {web ? <WebRows shared={shared} work={work} web={web} text={text} tabId={ctx.tabId} onKey={(event) => onKey(event, null)} /> : sections.web.length ? section("web", "웹", sections.web, creation, "이 프로젝트에 새 웹 페이지") : null}
        <LinkLines tree={list} />
      </div>
    </div>
  );
}
