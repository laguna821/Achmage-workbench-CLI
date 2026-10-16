import { useState } from "react";
import type { State } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { WorkTree, type TreeActions } from "./WorkTree.tsx";

/** Full-screen work finder (mockup 04): search, recent / folders, nested folders. */
export function Finder({
  state,
  currentWorkId,
  actions,
  onBack,
}: {
  state: State;
  currentWorkId: string | null;
  actions: TreeActions;
  onBack: (() => void) | null;
}) {
  const [tab, setTab] = useState<"recent" | "folders">("folders");
  const [query, setQuery] = useState("");
  const [creatingAt, setCreatingAt] = useState<string | null | undefined>(undefined);
  const attention = Object.values(state.sessions).filter((session) => session.status === "awaitingApproval");

  return (
    <main className="finder-view">
      <div className="column finder-inner">
        <h1 className="page-title">작업 찾기</h1>
        <label className="search-field">
          <Icon name="search" size={18} />
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="작업, 세션, 폴더 찾기" />
        </label>
        {!query.trim() ? (
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
                  if (work) actions.onOpenSession(work, attention[0]);
                }}
              >
                내 확인 {attention.length}개 보기 <Icon name="arrowRight" size={15} />
              </button>
            ) : null}
          </>
        ) : null}
        <WorkTree
          state={state}
          currentWorkId={currentWorkId}
          mode={tab}
          query={query}
          creatingAt={creatingAt}
          onCreatingDone={() => setCreatingAt(undefined)}
          actions={actions}
        />
        {!query.trim() ? (
          <div className="finder-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setTab("folders");
                setCreatingAt(null);
              }}
            >
              <Icon name="plus" size={14} /> 폴더
            </button>
            <button type="button" className="text-button" onClick={() => actions.onNewWork(null)}>
              <Icon name="plus" size={14} /> 작업
            </button>
          </div>
        ) : null}
        {onBack ? (
          <button type="button" className="back-link" onClick={onBack}>
            <Icon name="arrowLeft" size={15} /> {currentWorkId ? `${state.works[currentWorkId]?.title ?? "작업"}로 돌아가기` : "돌아가기"}
          </button>
        ) : null}
      </div>
    </main>
  );
}
