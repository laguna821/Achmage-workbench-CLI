import { useMemo, useState } from "react";
import type { Artifact, Folder, Session, Work } from "@workbench/contracts";
import type { State } from "../state.ts";
import { ago } from "../format.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { docIcon } from "./nav/rows.tsx";

// 보관함: what the user archived (a folder takes its contents along) and the documents they deleted
// (a document's file waits in the app's trash). "되돌리기" puts it back where it was; only "영구 삭제"
// of a document deletes anything. Archived conversations stay searchable ("보관 포함").

type Entry =
  | { kind: "folder"; at: number; folder: Folder; contents: number }
  | { kind: "work"; at: number; work: Work; sessions: number }
  | { kind: "session"; at: number; session: Session }
  | { kind: "document"; at: number; artifact: Artifact };

export function ArchiveView({
  state,
  onRestore,
  onOpenSession,
  onOpenWork,
  onDeleteWork,
  onRestoreDoc,
  onPurgeDoc,
  onSaveDocElsewhere,
  onClose,
}: {
  state: State;
  onRestore: (target: { kind: "folder" | "work" | "session"; id: string }) => void;
  onOpenSession: (session: Session) => void;
  onOpenWork: (work: Work) => void;
  onDeleteWork?: (work: Work) => void;
  onRestoreDoc?: (artifact: Artifact) => void;
  onPurgeDoc?: (artifact: Artifact) => Promise<unknown>;
  /** Its file out of the trash to a place the user picks (its folder or project is gone). */
  onSaveDocElsewhere?: (artifact: Artifact) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [purging, setPurging] = useState<Artifact | null>(null);
  // A document AI whose document was deleted comes back with its document, never alone.
  const retired = (session: Session) => Boolean(session.documentAgent && !state.artifacts[session.documentAgent.artifactId]);
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
    for (const artifact of Object.values(state.removedArtifacts)) {
      if (!artifact.removed || !match(`${artifact.name} ${state.works[artifact.workId]?.title ?? artifact.removed.workTitle ?? ""}`)) continue;
      out.push({ kind: "document", at: artifact.removed.at, artifact });
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
        <p className="muted archive-note">보관해도 지워지지 않습니다. 되돌리면 원래 자리로 돌아갑니다. 목록에서 뺀 문서와 앱 휴지통으로 옮긴 문서도 여기 있습니다. 보관한 대화는 찾기에서 "보관 포함"으로 찾을 수 있습니다.</p>
        {entries.length ? (
          <ul className="archive-list">
            {entries.map((entry) => {
              const key = entry.kind === "folder" ? entry.folder.id : entry.kind === "work" ? entry.work.id : entry.kind === "document" ? entry.artifact.id : entry.session.id;
              if (entry.kind === "document") {
                const { artifact } = entry;
                const project = state.works[artifact.workId]?.title ?? (artifact.removed?.workTitle ? `${artifact.removed.workTitle} (지운 프로젝트)` : "");
                return (
                  <li key={key} className="archive-row">
                    <Icon name={docIcon(artifact)} size={17} />
                    <span className="archive-title">{artifact.name}</span>
                    <span className="muted">문서 · {project}{artifact.removed?.kind === "unlisted" ? " · 목록에서 뺌 · 파일은 그대로" : " · 앱 휴지통"}</span>
                    <span className="muted archive-when">{ago(entry.at)} {artifact.removed?.kind === "unlisted" ? "뺌" : "지움"}</span>
                    {/* Back to its project's list; a deleted project has no list, so its trashed file is saved elsewhere instead. */}
                    {onRestoreDoc && !artifact.removed?.orphaned ? <button type="button" className="button small" onClick={() => onRestoreDoc(artifact)} title="프로젝트 목록으로 되돌리기"><Icon name="restore" size={14} /> 되돌리기</button> : null}
                    {onSaveDocElsewhere && artifact.removed?.orphaned && artifact.removed.kind === "trash" ? <button type="button" className="button small" onClick={() => onSaveDocElsewhere(artifact)} title="휴지통의 파일을 고른 곳에 복사합니다">다른 곳에 저장…</button> : null}
                    {/* Only the app's own trash is the app's to delete; an unlisted file is never touched. */}
                    {onPurgeDoc && artifact.removed?.kind === "trash" ? <button type="button" className="button small danger" onClick={() => setPurging(artifact)}>영구 삭제…</button> : null}
                  </li>
                );
              }
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
                      <span className="muted">{retired(entry.session) ? `${state.removedArtifacts[entry.session.documentAgent!.artifactId]?.removed?.kind === "unlisted" ? "목록에서 뺀" : "지운"} 문서의 문서 AI · 기록` : "세션"} · {state.works[entry.session.workId]?.title ?? ""}</span>
                    </button>
                  )}
                  <span className="muted archive-when">{ago(entry.at)} 보관</span>
                  {entry.kind === "session" && retired(entry.session) ? null : (
                    <button
                      type="button"
                      className="button small"
                      onClick={() => onRestore({ kind: entry.kind, id: key })}
                      title="원래 자리로 되돌리기"
                    >
                      <Icon name="restore" size={14} /> 되돌리기
                    </button>
                  )}
                  {entry.kind === "work" && onDeleteWork ? <button type="button" className="button small danger" onClick={() => onDeleteWork(entry.work)}>프로젝트 삭제…</button> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="empty-hint">{query ? "찾은 것이 없습니다." : "보관한 것이 없습니다. 사이드바에서 오른쪽 클릭 → 보관으로 옮길 수 있습니다."}</div>
        )}
        {purging && onPurgeDoc ? (
          <ConfirmDialog
            title={`「${purging.name}」을(를) 영구 삭제할까요?`}
            lines={[
              "앱 휴지통의 이 파일과 판 기록을 지웁니다. 되돌릴 수 없습니다.",
              purging.removed?.trashPath ?? purging.path,
              ...(purging.removed?.sessionIds?.length ? [`문서 AI 대화 ${purging.removed.sessionIds.length}개는 읽기 전용 기록으로 남습니다.`] : []),
            ]}
            confirmLabel="영구 삭제"
            busyLabel="삭제 중…"
            onConfirm={() => onPurgeDoc(purging)}
            onClose={() => setPurging(null)}
          />
        ) : null}
      </div>
    </main>
  );
}
