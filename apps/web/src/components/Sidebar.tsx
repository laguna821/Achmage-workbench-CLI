import { useState } from "react";
import type { State } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { WorkTree, type TreeActions } from "./WorkTree.tsx";

/** Optional pinned sidebar (closed by default, per PRD 2.1): new work, search and the folder tree. */
export function Sidebar({ state, currentWorkId, actions }: { state: State; currentWorkId: string | null; actions: TreeActions }) {
  const [query, setQuery] = useState("");
  const [creatingAt, setCreatingAt] = useState<string | null | undefined>(undefined);
  return (
    <aside className="sidebar" aria-label="작업 목록">
      <button type="button" className="sidebar-new" onClick={() => actions.onNewWork(null)}>
        <Icon name="plus" size={15} /> 새 작업
      </button>
      <label className="sidebar-search">
        <Icon name="search" size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="찾기" />
      </label>
      <div className="sidebar-tree">
        <WorkTree
          state={state}
          currentWorkId={currentWorkId}
          mode="folders"
          query={query}
          compact
          creatingAt={creatingAt}
          onCreatingDone={() => setCreatingAt(undefined)}
          actions={actions}
        />
      </div>
      <div className="sidebar-foot">
        <button type="button" className="text-button" onClick={() => setCreatingAt(null)}>
          <Icon name="plus" size={14} /> 폴더
        </button>
      </div>
    </aside>
  );
}
