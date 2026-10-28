import { useMemo, useState } from "react";
import type { Folder, Session, Work } from "@workbench/contracts";
import type { State } from "../state.ts";
import { ago } from "../format.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";

// 보관함: what the user archived (a folder takes its contents along). Nothing here is deleted;
// "되돌리기" puts it back where it was. Archived conversations stay searchable ("보관 포함").

type Entry =
  | { kind: "folder"; at: number; folder: Folder; contents: number }
  | { kind: "work"; at: number; work: Work; sessions: number }
  | { kind: "session"; at: number; session: Session };

export function ArchiveView({
  state,
  onRestore,
  onOpenSession,
  onOpenWork,
  onClose,
}: {
  state: State;
  onRestore: (target: { kind: "folder" | "work" | "session"; id: string }) => void;
  onOpenSession: (session: Session) => void;
  onOpenWork: (work: Work) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const match = (text: string) => !needle || text.toLowerCase().includes(needle);
    const out: Entry[] = [];
    for (const folder of Object.values(state.folders)) {
      if (!folder.archivedAt || !match(folder.name)) continue;
      const contents = Object.values(state.works).filter((work) => work.folderId === folder.id).length + Object.values(state.folders).filter((child) => child.parentId === folder.id).length;
      out.push({ kind: "folder", at: folder.archivedAt, folder, contents });
    }
    for (const work of Object.values(state.works)) {
      if (!work.archivedAt || !match(work.title)) continue;
      out.push({ kind: "work", at: work.archivedAt, work, sessions: Object.values(state.sessions).filter((session) => session.workId === work.id).length });
    }
    for (const session of Object.values(state.sessions)) {
      if (!session.archivedAt || !match(`${session.purpose} ${state.works[session.workId]?.title ?? ""}`)) continue;
      out.push({ kind: "session", at: session.archivedAt, session });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [state, query]);

  return (
    <main className="archive-view">
      <div className="archive-inner">
        <div className="archive-head">
          <h1 className="page-title">
            <Icon name="archive" size={22} /> 보관함
          </h1>
          <label className="search-field archive-search">
            <Icon name="search" size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="보관한 것 찾기" autoFocus />
          </label>
          <button type="button" className="icon-button" onClick={onClose} aria-label="닫기" title="닫기">
            <Icon name="x" size={18} />
          </button>
        </div>
        <p className="muted archive-note">보관해도 지워지지 않습니다. 되돌리면 원래 자리로 돌아갑니다. 보관한 대화는 찾기에서 "보관 포함"으로 찾을 수 있습니다.</p>
        {entries.length ? (
          <ul className="archive-list">
            {entries.map((entry) => {
              const key = entry.kind === "folder" ? entry.folder.id : entry.kind === "work" ? entry.work.id : entry.session.id;
              return (
                <li key={key} className="archive-row">
                  {entry.kind === "folder" ? (
                    <>
                      <Icon name="folder" size={17} />
                      <span className="archive-title">{entry.folder.name}</span>
                      <span className="muted">폴더 · 안에 {entry.contents}개</span>
                    </>
                  ) : entry.kind === "work" ? (
                    <button type="button" className="archive-open" onClick={() => onOpenWork(entry.work)}>
                      <Icon name="project" size={17} />
                      <span className="archive-title">{entry.work.title}</span>
                      <span className="muted">작업 · 세션 {entry.sessions}개</span>
                    </button>
                  ) : (
                    <button type="button" className="archive-open" onClick={() => onOpenSession(entry.session)}>
                      <EngineMark provider={entry.session.provider} size={16} />
                      <span className="archive-title">{entry.session.purpose}</span>
                      <span className="muted">세션 · {state.works[entry.session.workId]?.title ?? ""}</span>
                    </button>
                  )}
                  <span className="muted archive-when">{ago(entry.at)} 보관</span>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => onRestore({ kind: entry.kind, id: key })}
                    title="원래 자리로 되돌리기"
                  >
                    <Icon name="restore" size={14} /> 되돌리기
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="empty-hint">{query ? "찾은 것이 없습니다." : "보관한 것이 없습니다. 사이드바에서 오른쪽 클릭 → 보관으로 옮길 수 있습니다."}</div>
        )}
      </div>
    </main>
  );
}
