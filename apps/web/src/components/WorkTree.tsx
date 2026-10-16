import { useState } from "react";
import type { Folder, Session, Work } from "@workbench/contracts";
import { folderPath, isBusy, sessionsOf, type State } from "../state.ts";
import { sessionLabel, statusTone } from "../format.ts";
import { Icon } from "./Icon.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { accentStyle, useAppearance } from "../appearance.ts";

const COLLAPSED_KEY = "workbench.collapsedFolders";

function workBadge(sessions: Session[]) {
  if (sessions.some((session) => session.status === "awaitingApproval")) return { text: "확인 필요", tone: "attention" };
  if (sessions.some((session) => isBusy(session))) return { text: "진행 중", tone: "active" };
  return null;
}

export type TreeActions = {
  onOpenWork: (work: Work) => void;
  onOpenSession: (work: Work, session: Session) => void;
  onNewWork: (folderId: string | null) => void;
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>;
};

/**
 * Folder tree of works shared by the work finder and the optional sidebar. Folders are app-level
 * categories; moving a work never moves its files.
 */
export function WorkTree({
  state,
  currentWorkId,
  mode,
  query,
  compact,
  creatingAt,
  onCreatingDone,
  actions,
}: {
  state: State;
  currentWorkId: string | null;
  mode: "folders" | "recent";
  query: string;
  compact?: boolean;
  /** Parent folder of a folder being created inline (undefined = none being created). */
  creatingAt: string | null | undefined;
  onCreatingDone: () => void;
  actions: TreeActions;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]));
  const [folderName, setFolderName] = useState("");
  const [creatingInside, setCreatingInside] = useState<string | null | undefined>(undefined);
  const creating = creatingInside !== undefined ? creatingInside : creatingAt;
  const indent = compact ? 16 : 22;
  const { lookOf, openMenu } = useAppearance();

  const works = Object.values(state.works);
  const folders = Object.values(state.folders);

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  };

  const finishCreating = () => {
    setCreatingInside(undefined);
    setFolderName("");
    onCreatingDone();
  };

  const workRow = (work: Work, depth: number) => {
    const sessions = sessionsOf(state, work.id);
    const badge = workBadge(sessions);
    const current = work.id === currentWorkId;
    return (
      <li key={work.id}>
        <button type="button" className={`tree-row work-row${current ? " current" : ""}`} style={{ paddingLeft: 12 + depth * indent }} onClick={() => actions.onOpenWork(work)}>
          <Icon name="file" size={15} />
          <span className="tree-label">{work.title}</span>
          {badge ? compact ? <span className={`dot dot-${badge.tone}`} title={badge.text} /> : <span className={`badge badge-${badge.tone}`}>{badge.text}</span> : null}
        </button>
        {current && sessions.length ? (
          <ul>
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="tree-row session-row"
                  style={{ paddingLeft: 36 + depth * indent, ...accentStyle(lookOf(session.provider)) }}
                  onClick={() => actions.onOpenSession(work, session)}
                  onContextMenu={(event) => openMenu(event, session.provider)}
                >
                  {isBusy(session) ? <span className={`dot dot-${statusTone(session)}`} /> : <EngineMark provider={session.provider} size={13} className="session-row-mark" />}
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
    creating !== undefined && creating === parentId ? (
      <li>
        <form
          className="tree-row tree-form"
          style={{ paddingLeft: 12 + depth * indent }}
          onSubmit={(event) => {
            event.preventDefault();
            const name = folderName.trim();
            if (!name) return;
            void actions.onCreateFolder(name, parentId).then(finishCreating);
          }}
        >
          <Icon name="folder" size={15} />
          <input
            autoFocus
            value={folderName}
            placeholder="폴더 이름"
            onChange={(event) => setFolderName(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && finishCreating()}
          />
        </form>
      </li>
    ) : null;

  const folderNode = (folder: Folder, depth: number) => {
    const open = !collapsed.has(folder.id);
    const children = folders.filter((child) => child.parentId === folder.id).sort((a, b) => a.sort - b.sort);
    const folderWorks = works.filter((work) => work.folderId === folder.id).sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <li key={folder.id}>
        <div className="tree-row folder-row" style={{ paddingLeft: 12 + depth * indent }}>
          <button type="button" className="tree-toggle" onClick={() => toggle(folder.id)} aria-expanded={open}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
            <Icon name="folder" size={15} />
            <span className="tree-label">{folder.name}</span>
          </button>
          <span className="row-actions">
            <button type="button" className="icon-button small" title="하위 폴더" onClick={() => setCreatingInside(folder.id)}>
              <Icon name="folder" size={12} />
            </button>
            <button type="button" className="icon-button small" title="이 폴더에 새 작업" onClick={() => actions.onNewWork(folder.id)}>
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
  if (q) {
    const matches = works.filter(
      (work) =>
        work.title.toLowerCase().includes(q) ||
        sessionsOf(state, work.id).some((session) => session.purpose.toLowerCase().includes(q)) ||
        folderPath(state, work.folderId).some((folder) => folder.name.toLowerCase().includes(q)),
    );
    return <ul className="tree">{matches.length ? matches.map((work) => workRow(work, 0)) : <li className="empty-hint">찾은 작업이 없습니다.</li>}</ul>;
  }

  if (mode === "recent") {
    return <ul className="tree">{[...works].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20).map((work) => workRow(work, 0))}</ul>;
  }

  return (
    <ul className="tree">
      {creatingRow(null, 0)}
      {folders.filter((folder) => folder.parentId === null).sort((a, b) => a.sort - b.sort).map((folder) => folderNode(folder, 0))}
      {folders.length && works.some((work) => !work.folderId) ? <li className="tree-section">분류 없음</li> : null}
      {works.filter((work) => !work.folderId).sort((a, b) => b.updatedAt - a.updatedAt).map((work) => workRow(work, 0))}
      {!folders.length && !works.length ? <li className="empty-hint">아직 작업이 없습니다.</li> : null}
    </ul>
  );
}
