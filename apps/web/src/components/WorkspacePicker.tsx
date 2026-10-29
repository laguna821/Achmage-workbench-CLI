import { useCallback, useState } from "react";
import type { Provider, Session, Work, Workspace } from "@workbench/contracts";
import type { State } from "../state.ts";
import type { WorkActions } from "./WorkView.tsx";
import { Icon } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";
import "../styles/workspaces.css";

export function WorkspacePicker({ state, work, session, engine, actions }: { state: State; work: Work; session: Session | null; engine: Provider; actions: WorkActions }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const workspaces = Object.values(state.workspaces).filter((entry) => entry.workId === work.id);
  const current = state.workspaces[session?.workspaceId ?? work.defaultWorkspaceId ?? ""];
  const select = async (workspace: Workspace) => {
    setBusy(true);
    try {
      const candidates = Object.values(state.sessions).filter((entry) => entry.workspaceId === workspace.id && !entry.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt);
      const chosen = candidates[0] ?? await actions.newSession(work, session?.provider ?? engine, undefined, { workspaceId: workspace.id });
      if (chosen) { actions.selectSession(work, chosen); close(); }
    } finally { setBusy(false); }
  };
  if (!workspaces.length) return null;
  return <div className="anchor workspace-picker">
    <button type="button" className="ghost-button small workspace-trigger" aria-label="작업공간 선택" aria-expanded={open} title={current?.cwd} onClick={() => setOpen(!open)}>
      <Icon name="folder" size={14} /><span>{current?.label ?? "작업공간"}{current?.archivedAt ? " · 보관됨" : ""}</span><Icon name="chevronDown" size={12} />
    </button>
    <Popover open={open} onClose={close} className="workspace-menu">
      <div className="menu-label">{work.title} · 작업공간</div>
      {workspaces.map((workspace) => <div className={`workspace-choice${workspace.id === current?.id ? " active" : ""}`} key={workspace.id}>
        <button type="button" className="workspace-open" title={workspace.cwd} data-workspace-id={workspace.id} disabled={busy || workspace.archivedAt !== null || workspace.removedAt !== null} onClick={() => void select(workspace)}>
          <strong>{workspace.label}</strong><small>{workspace.cwd}</small>
          {workspace.removedAt ? <small>폴더 제거됨 · 기록 보존</small> : workspace.archivedAt ? <small>보관됨</small> : null}
        </button>
        {!workspace.removedAt ? <div className="workspace-tools">
          <button type="button" className="text-button" disabled={busy} aria-label={`${workspace.label} 이름 바꾸기`} onClick={() => { setEditing(workspace.id); setLabel(workspace.label); }}>이름</button>
          <button type="button" className="text-button" disabled={busy} aria-label={`${workspace.label} ${workspace.archivedAt ? "복원" : "보관"}`} onClick={async () => { setBusy(true); try { await actions.updateWorkspace(workspace, { archived: !workspace.archivedAt }); } finally { setBusy(false); } }}>{workspace.archivedAt ? "복원" : "보관"}</button>
        </div> : null}
      </div>)}
      {editing ? <form className="workspace-form" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { const target = state.workspaces[editing]; if (target && await actions.updateWorkspace(target, { label })) setEditing(null); } finally { setBusy(false); } }}>
        <input aria-label="작업공간 이름" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} /><button type="submit" className="button small" disabled={busy || !label.trim()}>이름 저장</button>
      </form> : null}
      <form className="workspace-form" onSubmit={async (event) => {
        event.preventDefault(); setBusy(true);
        try { const created = await actions.createWorkspace(work, path); if (created) { setPath(""); if (!created.archivedAt && !created.removedAt) await select(created); } }
        finally { setBusy(false); }
      }}>
        <label htmlFor={`workspace-path-${work.id}`}>다른 폴더 연결</label>
        <input id={`workspace-path-${work.id}`} aria-label="작업공간 폴더 경로" value={path} onChange={(event) => setPath(event.target.value)} placeholder="폴더의 전체 경로" />
        <button type="submit" className="button small" disabled={busy || !path.trim()}>작업공간 추가</button>
      </form>
      <div className="menu-label">보관하면 새 실행을 막습니다. 폴더와 세션 기록은 유지됩니다.</div>
    </Popover>
  </div>;
}
