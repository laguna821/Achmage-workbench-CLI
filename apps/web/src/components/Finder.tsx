import { useState } from "react";
import type { Folder, Session, Work } from "@workbench/contracts";
import { folderPath, isBusy, sessionsOf, type State } from "../state.ts";
import { sessionLabel } from "../format.ts";
import { Icon } from "./Icon.tsx";

const COLLAPSED_KEY = "workbench.collapsedFolders";

function workBadge(sessions: Session[]) {
  if (sessions.some((session) => session.status === "awaitingApproval")) return { text: "확인 필요", tone: "attention" };
  if (sessions.some((session) => isBusy(session))) return { text: "진행 중", tone: "active" };
  return null;
}

export function Finder({
  state,
  currentWorkId,
  onOpenWork,
  onOpenSession,
  onNewWork,
  onCreateFolder,
  onBack,
}: {
  state: State;
  currentWorkId: string | null;
  onOpenWork: (work: Work) => void;
  onOpenSession: (work: Work, session: Session) => void;
  onNewWork: (folderId: string | null) => void;
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>;
  onBack: (() => void) | null;
}) {
  const [tab, setTab] = useState<"recent" | "folders">("folders");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]));
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  const [folderName, setFolderName] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);

  const works = Object.values(state.works);
  const folders = Object.values(state.folders);
  const attention = Object.values(state.sessions).filter((session) => session.status === "awaitingApproval");

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  };

  const workRow = (work: Work, depth: number) => {
    const sessions = sessionsOf(state, work.id);
    const badge = workBadge(sessions);
    const current = work.id === currentWorkId;
    return (
      <li key={work.id}>
        <button type="button" className={`tree-row work-row${current ? " current" : ""}`} style={{ paddingLeft: 12 + depth * 22 }} onClick={() => onOpenWork(work)}>
          <Icon name="file" size={15} />
          <span className="tree-label">{work.title}</span>
          {badge ? <span className={`badge badge-${badge.tone}`}>{badge.text}</span> : null}
        </button>
        {current && sessions.length ? (
          <ul>
            {sessions.map((session) => (
              <li key={session.id}>
                <button type="button" className="tree-row session-row" style={{ paddingLeft: 36 + depth * 22 }} onClick={() => onOpenSession(work, session)}>
                  <span className="tree-label">{sessionLabel(session)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    );
  };

  const creatingRow = (parentId: string | null, depth: number) =>
    creating && creating.parentId === parentId ? (
      <li>
        <form
          className="tree-row tree-form"
          style={{ paddingLeft: 12 + depth * 22 }}
          onSubmit={(event) => {
            event.preventDefault();
            const name = folderName.trim();
            if (!name) return;
            void onCreateFolder(name, parentId).then(() => {
              setCreating(null);
              setFolderName("");
            });
          }}
        >
          <Icon name="folder" size={15} />
          <input autoFocus value={folderName} placeholder="폴더 이름" onChange={(event) => setFolderName(event.target.value)} onKeyDown={(event) => event.key === "Escape" && setCreating(null)} />
        </form>
      </li>
    ) : null;

  const folderNode = (folder: Folder, depth: number) => {
    const open = !collapsed.has(folder.id);
    const children = folders.filter((child) => child.parentId === folder.id).sort((a, b) => a.sort - b.sort);
    const folderWorks = works.filter((work) => work.folderId === folder.id).sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <li key={folder.id}>
        <div className={`tree-row folder-row${selectedFolder === folder.id ? " selected" : ""}`} style={{ paddingLeft: 12 + depth * 22 }}>
          <button
            type="button"
            className="tree-toggle"
            onClick={() => {
              toggle(folder.id);
              setSelectedFolder(folder.id);
            }}
            aria-expanded={open}
          >
            <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
            <Icon name="folder" size={15} />
            <span className="tree-label">{folder.name}</span>
          </button>
          <span className="row-actions">
            <button type="button" className="icon-button small" title="하위 폴더" onClick={() => setCreating({ parentId: folder.id })}>
              <Icon name="folder" size={12} />
            </button>
            <button type="button" className="icon-button small" title="이 폴더에 새 작업" onClick={() => onNewWork(folder.id)}>
              <Icon name="plus" size={12} />
            </button>
          </span>
        </div>
        {open ? (
          <ul>
            {creatingRow(folder.id, depth + 1)}
            {children.map((child) => folderNode(child, depth + 1))}
            {folderWorks.map((work) => workRow(work, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  const q = query.trim().toLowerCase();
  const matches = q
    ? works.filter(
        (work) =>
          work.title.toLowerCase().includes(q) ||
          sessionsOf(state, work.id).some((session) => session.purpose.toLowerCase().includes(q)) ||
          folderPath(state, work.folderId).some((folder) => folder.name.toLowerCase().includes(q)),
      )
    : [];

  return (
    <main className="finder-view">
      <div className="column finder-inner">
        <h1 className="page-title">작업 찾기</h1>
        <label className="search-field">
          <Icon name="search" size={18} />
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="작업, 세션, 폴더 찾기" />
        </label>
        {q ? (
          <ul className="tree">{matches.length ? matches.map((work) => workRow(work, 0)) : <li className="empty-hint">찾은 작업이 없습니다.</li>}</ul>
        ) : (
          <>
            <div className="tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "recent"} className={tab === "recent" ? "active" : ""} onClick={() => setTab("recent")}>
                최근
              </button>
              <button type="button" role="tab" aria-selected={tab === "folders"} className={tab === "folders" ? "active" : ""} onClick={() => setTab("folders")}>
                폴더
              </button>
            </div>
            {attention.length ? (
              <button
                type="button"
                className="attention-link"
                onClick={() => {
                  const work = state.works[attention[0].workId];
                  if (work) onOpenSession(work, attention[0]);
                }}
              >
                내 확인 {attention.length}개 보기 <Icon name="arrowRight" size={15} />
              </button>
            ) : null}
            {tab === "recent" ? (
              <ul className="tree">{[...works].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20).map((work) => workRow(work, 0))}</ul>
            ) : (
              <ul className="tree">
                {creatingRow(null, 0)}
                {folders.filter((folder) => folder.parentId === null).sort((a, b) => a.sort - b.sort).map((folder) => folderNode(folder, 0))}
                {folders.length && works.some((work) => !work.folderId) ? <li className="tree-section">분류 없음</li> : null}
                {works.filter((work) => !work.folderId).sort((a, b) => b.updatedAt - a.updatedAt).map((work) => workRow(work, 0))}
                {!folders.length && !works.length ? <li className="empty-hint">아직 작업이 없습니다.</li> : null}
              </ul>
            )}
            <div className="finder-actions">
              <button type="button" className="text-button" onClick={() => setCreating({ parentId: null })}>
                <Icon name="plus" size={14} /> 폴더
              </button>
              <button type="button" className="text-button" onClick={() => onNewWork(null)}>
                <Icon name="plus" size={14} /> 작업
              </button>
            </div>
          </>
        )}
        {onBack ? (
          <button type="button" className="back-link" onClick={onBack}>
            <Icon name="arrowLeft" size={15} /> {currentWorkId ? `${state.works[currentWorkId]?.title ?? "작업"}로 돌아가기` : "돌아가기"}
          </button>
        ) : null}
      </div>
    </main>
  );
}
