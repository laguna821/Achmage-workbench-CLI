import { useState, type RefObject } from "react";
import type { Row } from "../../tree.ts";
import { Icon } from "../Icon.tsx";
import { LinkLines } from "../LinkSidebar.tsx";
import { TreeRow } from "./rows.tsx";
import type { NavShared } from "./shared.ts";

// "한 칸": the sidebar's single tree as it was (folders › works › sessions and documents), with its
// own order (직접 · 최근 · 이름) and moves by dragging or Alt+↑↓.

export function TreeSection({ shared, rows, treeRef, onSort }: { shared: NavShared; rows: Row[]; treeRef: RefObject<HTMLDivElement | null>; onSort: (button: HTMLElement) => void }) {
  const [folderName, setFolderName] = useState("");
  const creatingRow = (
    <form
      className="side-row creating"
      onSubmit={(event) => {
        event.preventDefault();
        const name = folderName.trim();
        if (!name) return;
        void shared.actions.createFolder(name, shared.creatingIn ?? null).then(() => {
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
  return (
    <section className="side-section side-tree-section" aria-label="작업 공간">
      <div className="side-section-title with-tools">
        <span>작업 공간</span>
        <span className="side-tools">
          <button type="button" className="icon-button small" title="새 폴더" onClick={() => shared.setCreatingIn(null)}>
            <Icon name="plus" size={13} />
          </button>
          <button type="button" className="icon-button small" title="정렬" aria-haspopup="menu" onClick={(event) => onSort(event.currentTarget)}>
            <Icon name="dots" size={13} />
          </button>
        </span>
      </div>
      <div className="side-tree" role="tree" aria-label="작업 공간" ref={treeRef}>
        {shared.creatingIn === null ? creatingRow : null}
        {rows.map((row) => (
          <div key={row.id} className="side-tree-item">
            <TreeRow row={row} ctx={shared.rowCtx} />
            {shared.creatingIn !== undefined && shared.creatingIn === row.id && row.type === "folder" ? <div style={{ paddingLeft: 14 * (row.depth + 1) }}>{creatingRow}</div> : null}
          </div>
        ))}
        {!rows.length && shared.creatingIn === undefined ? <div className="empty-hint side-empty">아직 작업이 없습니다. 위의 "새 세션"으로 시작하세요.</div> : null}
        <LinkLines tree={treeRef} />
      </div>
    </section>
  );
}
