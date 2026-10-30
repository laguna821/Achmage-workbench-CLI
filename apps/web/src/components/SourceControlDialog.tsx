import { useCallback, useEffect, useRef, useState } from "react";
import type { ScmAction, ScmArea, ScmDiff, ScmFile, ScmJob, ScmStatus, ScmRemoteInventory, ScmRemoteRequest, ScmRequest, Workspace } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { ScmReviewsProvider } from "./ScmReviewNotes.tsx";
import { ScmDiffText } from "./ScmDiffText.tsx";
import { ScmRemoteControls } from "./ScmRemoteControls.tsx";
import { ScmComparisonReview } from "./ScmComparisonReview.tsx";
import { GitHubReview } from "./GitHubReview.tsx";
import { conflictDraftKey, ScmConflictReview } from "./ScmConflictReview.tsx";
import "../styles/source-control.css";

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const phaseLabels: Record<ScmJob["phase"], string> = { running: "실행 중", complete: "완료", failed: "실패", interrupted: "중단 · 현재 상태 확인 필요" };
const actionLabels: Record<ScmAction, string> = { stage: "스테이징", unstage: "스테이징 취소", commit: "커밋", fetch: "가져오기", pull: "받기", push: "보내기", resolve: "충돌 해결", continue: "작업 계속", abort: "작업 취소", "stage-hunks": "변경 구간 스테이징", "unstage-hunks": "변경 구간 스테이징 취소" };
export function SourceControlDialog({ api, workspace, onClose, onTerminal }: { api: Api; workspace: Workspace; onClose: () => void; onTerminal: () => void }) {
  const [tab, setTab] = useState<"changes" | "compare" | "github">("changes"), [compareEpoch, setCompareEpoch] = useState(0), [githubEpoch, setGithubEpoch] = useState(0);
  const [status, setStatus] = useState<ScmStatus | null>(null), [jobs, setJobs] = useState<ScmJob[]>([]), [error, setError] = useState("");
  const [remotes, setRemotes] = useState<ScmRemoteInventory | null>(null);
  const [pending, setPending] = useState(false), [message, setMessage] = useState(() => { try { return localStorage.getItem(`scm-message:${workspace.id}`) ?? ""; } catch { return ""; } });
  const [selected, setSelected] = useState<{ path: string; area: ScmArea } | null>(null), [diff, setDiff] = useState<ScmDiff | null>(null);
  const [wrap, setWrap] = useState(false), [imageMode, setImageMode] = useState<"side" | "overlay">("side");
  const [resolutionEpoch, setResolutionEpoch] = useState(0), [abortRevision, setAbortRevision] = useState<string | null>(null);
  const alive = useRef(true), activeJob = useRef<string | null>(null), loadVersion = useRef(0);
  useEffect(() => { try { if (message) localStorage.setItem(`scm-message:${workspace.id}`, message); else localStorage.removeItem(`scm-message:${workspace.id}`); } catch { /* The visible draft stays available when browser storage is full. */ } }, [message, workspace.id]);
  const refresh = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const [next, history, inventory] = await Promise.all([api.scmStatus(workspace.id), api.scmJobs(workspace.id), api.scmRemotes(workspace.id).then((value) => ({ value, error: "" })).catch((reason) => ({ value: null, error: messageOf(reason) }))]);
      if (!alive.current || version !== loadVersion.current) return;
      setStatus(next); setJobs(history); setRemotes(inventory.value); setError(inventory.error);
      setSelected((current) => current && next.files.some((file) => file.path === current.path && (current.area === "staged" ? file.index !== "." && file.index !== "?" : file.working !== ".")) ? current : null);
    } catch (reason) { if (alive.current && version === loadVersion.current) setError(messageOf(reason)); }
  }, [api, workspace.id]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !(event.target instanceof Element && event.target.closest(".scm-note-editor"))) { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  useEffect(() => {
    let canceled = false; setDiff(null);
    if (status && selected && !status.files.some((file) => file.path === selected.path && file.conflicted)) void api.scmDiff(workspace.id, selected.path, selected.area, status.revision).then((result) => { if (!canceled) setDiff(result); }).catch((reason) => { if (!canceled) setError(messageOf(reason)); });
    return () => { canceled = true; };
  }, [api, workspace.id, status, selected]);
  const running = jobs.some((job) => job.phase === "running"), busy = pending || running;
  useEffect(() => {
    if (!running) return;
    let canceled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.scmJobs(workspace.id); if (canceled) return; setJobs(next);
        if (!next.some((job) => job.phase === "running")) {
          const completed = next.find((job) => job.id === activeJob.current);
          if (completed?.phase === "complete" && completed.request.action === "commit") setMessage("");
          if (completed?.phase === "complete" && completed.request.resolution) {
            try { localStorage.removeItem(conflictDraftKey(workspace.id, completed.request.resolution.path)); } catch { /* Keep storage errors local to the draft. */ }
            setResolutionEpoch((value) => value + 1);
          }
          activeJob.current = null; await refresh();
        } else timer = setTimeout(() => void poll(), 400);
      } catch (reason) { if (!canceled) { setError(messageOf(reason)); timer = setTimeout(() => void poll(), 1500); } }
    };
    timer = setTimeout(() => void poll(), 200); return () => { canceled = true; clearTimeout(timer); };
  }, [api, workspace.id, running, refresh]);
  const act = async (action: ScmAction, paths?: string[], remote?: ScmRemoteRequest, extra?: Pick<ScmRequest, "resolution" | "operation" | "confirmAbort" | "expectedRevision" | "selection">) => {
    if (!status || busy) return; setPending(true); setError("");
    try {
      const job = await api.startScm(workspace.id, { requestId: crypto.randomUUID(), expectedRevision: status.revision, action, ...(paths ? { paths } : {}), ...(action === "commit" ? { message } : {}), ...(remote ? { remote } : {}), ...extra });
      activeJob.current = job.id; if (alive.current) setJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)]);
    } catch (reason) { if (alive.current) setError(messageOf(reason)); }
    finally { if (alive.current) setPending(false); }
  };
  const section = (title: string, area: ScmArea, files: ScmFile[]) => <section className={`scm-file-section ${area}`}>
    <header><strong>{title} <span>{files.length}</span></strong>{files.length && !files.some((file) => file.conflicted) ? <button className="text-button scm-all" disabled={busy} onClick={() => void act(area === "staged" ? "unstage" : "stage", files.map((file) => file.path))}>{area === "staged" ? "모두 취소" : "모두 스테이징"}</button> : null}</header>
    {files.map((file) => <div className={`scm-file${selected?.path === file.path && selected.area === area ? " selected" : ""}`} key={file.path}>
      <button className="scm-file-select" title={file.path} data-path={file.path} data-area={area} onClick={() => setSelected({ path: file.path, area })}><span className={file.conflicted ? "scm-conflict" : ""}>{file.conflicted ? "!" : area === "staged" ? file.index : file.working}</span><span>{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</span></button>
      <button className="text-button scm-file-action" aria-label={`${file.path} ${file.conflicted ? "충돌 검토" : area === "staged" ? "스테이징 취소" : "스테이징"}`} disabled={busy} onClick={() => file.conflicted ? setSelected({ path: file.path, area: "working" }) : void act(area === "staged" ? "unstage" : "stage", [file.path])}>{file.conflicted ? "검토" : area === "staged" ? "−" : "+"}</button>
    </div>)}
    {!files.length ? <p className="muted">변경 없음</p> : null}
  </section>;
  const staged = status?.files.filter((file) => file.index !== "." && file.index !== "?" && !file.conflicted) ?? [];
  const working = status?.files.filter((file) => file.working !== "." && !file.conflicted) ?? [];
  const conflicts = status?.files.filter((file) => file.conflicted) ?? [];
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="scm-dialog" role="dialog" aria-modal="true" aria-label="Git 변경 검토"><ScmReviewsProvider api={api} workspace={workspace}>
    <header className="scm-header"><div><h2>Git 변경 검토</h2><p><strong>{status?.branch ?? (status?.head ? "분리된 HEAD" : workspace.label)}</strong>{status?.head ? ` · ${status.head.slice(0, 8)}` : " · 첫 커밋 전"}{status?.operation ? ` · ${status.operation} 진행 중` : ""}</p><small title={status?.root}>{status?.root ?? workspace.cwd}</small>{status?.upstream ? <small>{status.upstream} · 보낼 커밋 {status.ahead} · 받을 커밋 {status.behind}</small> : null}</div><button className="button scm-refresh" disabled={busy} onClick={() => { void refresh(); if (tab === "compare") setCompareEpoch((value) => value + 1); if (tab === "github") setGithubEpoch((value) => value + 1); }}>새로고침</button><button className="button scm-close" onClick={onClose}>닫기</button></header>
    <nav className="scm-review-tabs" aria-label="Git 검토 보기"><button className={`button scm-tab-changes${tab === "changes" ? " primary" : ""}`} aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>스테이징·커밋</button><button className={`button scm-tab-compare${tab === "compare" ? " primary" : ""}`} aria-pressed={tab === "compare"} onClick={() => setTab("compare")}>기준·커밋 비교</button><button className={`button scm-tab-github${tab === "github" ? " primary" : ""}`} aria-pressed={tab === "github"} onClick={() => setTab("github")}>PR·CI</button>{tab === "compare" ? <button className="text-button scm-compare-refresh" onClick={() => setCompareEpoch((value) => value + 1)}>비교 새로고침</button> : null}</nav>
    {tab === "github" ? <GitHubReview api={api} workspaceId={workspace.id} refreshEpoch={githubEpoch} /> : tab === "compare" && status ? <ScmComparisonReview api={api} workspace={workspace} defaultBase={workspace.worktree?.base ?? (status.head ? "HEAD" : "")} refreshEpoch={compareEpoch} /> : <>
    {error ? <p className="scm-error" role="alert">{error}</p> : null}
    <div className="scm-body"><aside className="scm-sidebar">{status && remotes ? <ScmRemoteControls key={workspace.id + ":" + remotes.revision} api={api} status={status} inventory={remotes} busy={busy} act={(action, remote) => act(action, undefined, remote)} onError={setError} onTerminal={onTerminal} /> : null}{status ? <>{status.operation ? <section className="scm-operation"><strong>{status.operation} 진행 중 · 충돌 {conflicts.length}개</strong><p>해결한 파일을 스테이징한 뒤 계속합니다. 저장소의 커밋 메시지와 검사 훅을 사용합니다.</p><button className="button primary scm-continue" disabled={busy || conflicts.length > 0} onClick={() => void act("continue", undefined, undefined, { expectedRevision: status.revision, operation: status.operation! })}>해결한 작업 계속</button><details><summary>진행 중인 작업 취소</summary><p>현재 작업의 해결 내용을 되돌릴 수 있습니다. 변경 파일·인덱스의 복구 사본을 로컬에 보관한 뒤 Git의 취소 명령을 실행합니다.</p><label><input className="scm-abort-confirm" type="checkbox" checked={abortRevision === status.revision} onChange={(event) => setAbortRevision(event.target.checked ? status.revision : null)} />현재 변경을 확인했고 작업을 취소합니다.</label><button className="button scm-abort" disabled={busy || abortRevision !== status.revision} onClick={() => void act("abort", undefined, undefined, { expectedRevision: status.revision, operation: status.operation!, confirmAbort: true })}>{status.operation} 취소</button></details></section> : null}{conflicts.length ? section("해결할 충돌", "working", conflicts) : null}{section("스테이징된 변경", "staged", staged)}{section("작업 폴더 변경", "working", working)}</> : <p>변경을 불러오는 중…</p>}
      <form className="scm-commit-form" onSubmit={(event) => { event.preventDefault(); void act("commit"); }}><label htmlFor="scm-message">커밋 내용</label><textarea id="scm-message" value={message} maxLength={32000} placeholder="무엇을 왜 바꿨는지" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (message.trim() && staged.length) void act("commit"); } }} /><small>스테이징한 변경을 커밋합니다. 저장소의 검사 훅도 실행됩니다.</small><button className="button primary scm-commit" disabled={busy || !message.trim() || (!staged.length && status?.operation !== "merge") || status?.files.some((file) => file.conflicted)}>커밋</button></form>
    </aside><main className={`scm-review${wrap ? " wrap" : ""}`}>
      {selected && status && conflicts.some((file) => file.path === selected.path) ? <ScmConflictReview key={workspace.id + ":" + selected.path + ":" + resolutionEpoch} api={api} status={status} path={selected.path} busy={busy} submit={(resolution, expectedRevision) => act("resolve", undefined, undefined, { resolution, expectedRevision })} onError={setError} onTerminal={onTerminal} /> : selected ? <><header className="scm-diff-header"><strong>{selected.path}</strong><span>{selected.area === "staged" ? "HEAD → 스테이징" : "스테이징 → 작업 파일"}</span><label><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />줄바꿈</label></header>{diff ? <>{diff.images ? <><div className="scm-image-tools"><button className="button small" onClick={() => setImageMode(imageMode === "side" ? "overlay" : "side")}>{imageMode === "side" ? "겹쳐 보기" : "나란히 보기"}</button><span>이전 / 이후 · 최대 8 MiB</span></div><div className={`scm-images ${imageMode}`}>{(["before", "after"] as const).map((side) => <figure key={side}>{diff.images![side] ? <img src={diff.images![side]!} alt={side === "before" ? "이전 이미지" : "이후 이미지"} /> : <span>이미지 없음 또는 크기 제한</span>}<figcaption>{side === "before" ? "이전" : "이후"}</figcaption></figure>)}</div></> : null}{diff.truncated ? <p className="scm-warning">변경이 커서 앞부분만 표시합니다. 전체 파일을 확인한 뒤 스테이징하세요.</p> : null}<ScmDiffText diff={diff} busy={busy} onHunks={(hunks) => void act(diff.area === "working" ? "stage-hunks" : "unstage-hunks", undefined, undefined, { expectedRevision: status!.revision, selection: { path: diff.path, expectedRevision: diff.revision, hunks } })} /></> : <p className="scm-placeholder">차이를 불러오는 중…</p>}</> : <p className="scm-placeholder">파일을 선택해 변경을 검토하세요.</p>}
    </main></div>
    <footer className="scm-history"><h3>Git 작업 기록</h3>{jobs.slice(0, 12).map((job, index) => <details key={job.id} open={index === 0}><summary><strong>{actionLabels[job.request.action]}</strong> · <span className={`scm-phase ${job.phase}`}>{phaseLabels[job.phase]}</span> · {job.branch ?? "분리된 HEAD"} · {new Date(job.createdAt).toLocaleTimeString()}{job.headAfter && job.headAfter !== job.headBefore ? ` · ${job.headAfter.slice(0, 8)}` : ""}</summary>{job.phase === "running" ? <button className="button small scm-interrupt" onClick={() => void api.interruptScm(job.id).then(() => refresh()).catch((reason) => setError(messageOf(reason)))}>중단 · 변경은 현재 상태 유지</button> : null}{job.error ? <p className="scm-error">{job.error}</p> : null}{job.request.remote ? <p>{job.request.remote.remote}/{job.request.remote.branch}{job.request.remote.strategy ? ` · ${job.request.remote.strategy}` : ""}{job.request.remote.forcePreviewId ? " · 확인한 커밋에 lease 적용" : ""}</p> : null}{job.remoteResults?.map((result, n) => <p className="scm-remote-results" key={n}>{result.url} · {result.phase === "complete" ? "보내기 완료" : result.phase === "failed" ? "실패" : "미실행"}{result.error ? ` · ${result.error}` : ""}</p>)}{job.request.selection ? <p>{job.request.selection.path} · {job.request.selection.hunks.length}개 구간</p> : null}{job.request.resolution ? <p>{job.request.resolution.path} · {job.request.resolution.choice} · {job.request.resolution.stage ? "스테이징 포함" : "파일 저장"}</p> : null}{job.recoveryPath ? <p className="scm-recovery-path">변경 전 복구 파일: <code>{job.recoveryPath}</code></p> : null}{job.request.message ? <p>{job.request.message}</p> : null}{job.outputTruncated ? <small>최근 출력만 표시합니다.</small> : null}{job.output ? <pre>{job.output}</pre> : <small>{job.phase === "running" ? "Git 응답을 기다리는 중…" : "추가 출력 없음"}</small>}</details>)}{!jobs.length ? <small>아직 실행한 Git 작업이 없습니다.</small> : null}</footer>
    </>}
  </ScmReviewsProvider></div></div>;
}
