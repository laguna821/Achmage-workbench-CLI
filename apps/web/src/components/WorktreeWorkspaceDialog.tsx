import { useEffect, useState } from "react";
import type { Work, Workspace, WorkspaceRepository, WorktreeCreation } from "@workbench/contracts";
import type { State } from "../state.ts";
import type { WorkActions } from "./WorkView.tsx";

const running = (job: WorktreeCreation) => job.phase === "checking" || job.phase === "creating";
const phaseLabel: Record<WorktreeCreation["phase"], string> = { checking: "기준 확인 중", creating: "워크트리 생성 중", ready: "생성 완료", canceled: "취소됨", failed: "생성 실패", interrupted: "완료 확인 필요" };
export function WorktreeWorkspaceDialog({ state, work, source, actions, onClose }: { state: State; work: Work; source: Workspace; actions: WorkActions; onClose(): void }) {
  const api = actions.workspaceGit;
  const [repo, setRepo] = useState<WorkspaceRepository | null>(null), [jobs, setJobs] = useState<WorktreeCreation[]>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [page, setPage] = useState<"connect" | "create" | "jobs">("connect");
  const [label, setLabel] = useState(""), [branch, setBranch] = useState(`workbench/${crypto.randomUUID().slice(0, 8)}`), [base, setBase] = useState("HEAD"), [parent, setParent] = useState(true);
  const fail = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  const refresh = async () => {
    setLoading(true); setError("");
    await Promise.allSettled([
      api.workspaceRepository(source.id).then(setRepo).catch((error) => { setRepo(null); fail(error); }),
      api.worktreeCreations(work.id).then(setJobs).catch(fail),
    ]);
    setLoading(false);
  };
  useEffect(() => { void refresh(); }, [source.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = jobs.some(running);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void api.worktreeCreations(work.id).then(setJobs).catch(fail); }, 600);
    return () => clearInterval(timer);
  }, [active, api, work.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [busy, onClose]);
  const open = async (workspace: Workspace) => { if (await actions.openWorkspace(workspace)) onClose(); };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="stage-dialog worktree-dialog" role="dialog" aria-modal="true" aria-label="Git 워크트리 관리">
      <header className="template-head"><h2>Git 워크트리</h2><button type="button" className="text-button" disabled={busy} onClick={onClose}>닫기</button></header>
      <p className="sheet-hint">{work.title} · {source.label}</p>
      <nav className="worktree-tabs" aria-label="워크트리 보기">
        <button type="button" className={`button small${page === "connect" ? " primary" : ""}`} onClick={() => setPage("connect")}>기존 워크트리</button>
        <button type="button" className={`button small${page === "create" ? " primary" : ""}`} onClick={() => setPage("create")}>새 워크트리</button>
        <button type="button" className={`button small${page === "jobs" ? " primary" : ""}`} onClick={() => setPage("jobs")}>생성 기록{active ? " · 진행 중" : ""}</button>
        <button type="button" className="text-button" disabled={loading || busy} onClick={() => void refresh()}>새로고침</button>
      </nav>
      {error ? <p className="worktree-error" role="alert">{error}</p> : null}
      {loading ? <p className="sheet-hint">저장소를 확인하는 중…</p> : null}
      {page === "connect" && repo ? <div className="worktree-list">
        <p className="sheet-hint">연결하면 같은 프로젝트에서 세션을 시작할 수 있습니다. 기존 파일은 그대로 사용합니다.</p>
        {repo.worktrees.map((tree) => <div className="worktree-row" key={tree.path}>
          <div><strong>{tree.branch || (tree.detached ? `커밋 ${tree.head.slice(0, 10)}` : "저장소")}</strong><code>{tree.path}</code><small>{tree.head.slice(0, 12)}{tree.locked ? ` · 잠김: ${tree.locked}` : ""}{tree.missing ? " · 경로 없음" : ""}{tree.prunable ? ` · ${tree.prunable}` : ""}</small></div>
          <button type="button" className="button small" disabled={busy || tree.bare || tree.missing || !!tree.prunable} data-worktree-path={tree.path} onClick={async () => {
            setBusy(true); setError("");
            try { await open(await api.connectWorktree(source.id, tree.path, tree.head)); } catch (error) { fail(error); } finally { setBusy(false); }
          }}>{tree.workspaceId ? "열기" : "연결"}</button>
        </div>)}
      </div> : null}
      {page === "create" && repo ? <form className="worktree-create" onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setError("");
        const expectedBase = base === "HEAD" ? repo.head : repo.refs.find((ref) => ref.name === base)?.commit;
        try {
          const job = await api.createWorktreeWorkspace(work.id, { requestId: crypto.randomUUID(), sourceWorkspaceId: source.id, label, branch, baseRef: base, ...(expectedBase ? { expectedBase } : {}), parentWorkspaceId: parent ? source.id : null });
          setJobs((before) => [job, ...before.filter((item) => item.id !== job.id)]); setPage("jobs");
        } catch (error) { fail(error); } finally { setBusy(false); }
      }}>
        <label>작업공간 이름<input aria-label="새 워크트리 이름" value={label} maxLength={80} placeholder="예: 검색 기능 개선" onChange={(event) => setLabel(event.target.value)} /></label>
        <label>새 브랜치<input aria-label="새 워크트리 브랜치" value={branch} maxLength={200} onChange={(event) => setBranch(event.target.value)} /></label>
        <label>시작할 ref<input aria-label="워크트리 기준 ref" list="worktree-refs" value={base} onChange={(event) => setBase(event.target.value)} /></label>
        <datalist id="worktree-refs"><option value="HEAD">현재 커밋</option>{repo.refs.map((ref) => <option key={ref.name} value={ref.name}>{ref.commit.slice(0, 10)}</option>)}</datalist>
        <p className="sheet-hint">로컬 브랜치·태그·저장된 원격 ref 또는 커밋에서 시작합니다. 아직 커밋하지 않은 변경은 복사하지 않습니다.</p>
        <label className="worktree-parent"><input type="checkbox" checked={parent} onChange={(event) => setParent(event.target.checked)} /> {source.label} 아래에 묶기</label>
        <button type="submit" className="button small primary" disabled={busy || !branch.trim() || !base.trim() || !repo.head}>워크트리 만들기</button>
      </form> : null}
      {page === "jobs" ? <div className="worktree-list">
        {!jobs.length ? <p className="sheet-hint">생성 기록이 없습니다.</p> : null}
        {jobs.map((job) => <div className="worktree-row worktree-job" data-creation-id={job.id} data-phase={job.phase} key={job.id}>
          <div><strong>{job.request.label || job.request.branch} · {phaseLabel[job.phase]}</strong><small>{job.request.baseRef}{job.base ? ` → ${job.base.slice(0, 12)}` : ""} · {job.branch ?? job.request.branch}</small>{job.path ? <code>{job.path}</code> : null}{job.error ? <p>{job.error}</p> : null}</div>
          {job.workspaceId && state.workspaces[job.workspaceId] ? <button type="button" className="button small" onClick={() => void open(state.workspaces[job.workspaceId!]!)}>작업공간 열기</button> : null}
          {running(job) ? <button type="button" className="button small" onClick={() => { void api.cancelWorktreeCreation(job.id).then(() => api.worktreeCreations(work.id)).then(setJobs).catch(fail); }}>생성 취소</button> : null}
        </div>)}
        <p className="sheet-hint">창을 닫아도 생성은 계속됩니다. 취소·실패 후 남은 폴더와 브랜치는 자동으로 삭제하지 않습니다.</p>
      </div> : null}
    </section>
  </div>;
}
