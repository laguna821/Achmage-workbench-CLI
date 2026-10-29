import { useCallback, useEffect, useRef, useState } from "react";
import type { ScmAction, ScmArea, ScmDiff, ScmFile, ScmJob, ScmStatus, Workspace } from "@workbench/contracts";
import type { Api } from "../api.ts";
import "../styles/source-control.css";

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const phaseLabels: Record<ScmJob["phase"], string> = { running: "실행 중", complete: "완료", failed: "실패", interrupted: "중단 · 현재 상태 확인 필요" };
const actionLabels: Record<ScmAction, string> = { stage: "스테이징", unstage: "스테이징 취소", commit: "커밋" };
function DiffLines({ patch }: { patch: string }) {
  let oldLine = 0, newLine = 0, inHunk = false;
  return <div className="scm-lines" role="table" aria-label="파일 변경 비교">{patch.split("\n").map((text, i) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; }
    if (/^diff |^index |^--- |^\+\+\+ /.test(text)) inHunk = false;
    const kind = hunk ? "hunk" : inHunk && text.startsWith("+") ? "add" : inHunk && text.startsWith("-") ? "del" : "context";
    const numbered = inHunk && !hunk && !text.startsWith("\\") && /^[ +\-]/.test(text);
    return <div role="row" className={`scm-line ${kind}`} key={i}><span role="cell" className="scm-line-number">{numbered && kind !== "add" ? oldLine++ : ""}</span><span role="cell" className="scm-line-number">{numbered && kind !== "del" ? newLine++ : ""}</span><code role="cell">{text || " "}</code></div>;
  })}</div>;
}

export function SourceControlDialog({ api, workspace, onClose }: { api: Api; workspace: Workspace; onClose: () => void }) {
  const [status, setStatus] = useState<ScmStatus | null>(null), [jobs, setJobs] = useState<ScmJob[]>([]), [error, setError] = useState("");
  const [pending, setPending] = useState(false), [message, setMessage] = useState(() => { try { return localStorage.getItem(`scm-message:${workspace.id}`) ?? ""; } catch { return ""; } });
  const [selected, setSelected] = useState<{ path: string; area: ScmArea } | null>(null), [diff, setDiff] = useState<ScmDiff | null>(null);
  const [wrap, setWrap] = useState(false), [imageMode, setImageMode] = useState<"side" | "overlay">("side");
  const alive = useRef(true), activeJob = useRef<string | null>(null), loadVersion = useRef(0);
  useEffect(() => { try { if (message) localStorage.setItem(`scm-message:${workspace.id}`, message); else localStorage.removeItem(`scm-message:${workspace.id}`); } catch { /* The visible draft stays available when browser storage is full. */ } }, [message, workspace.id]);
  const refresh = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const [next, history] = await Promise.all([api.scmStatus(workspace.id), api.scmJobs(workspace.id)]);
      if (!alive.current || version !== loadVersion.current) return;
      setStatus(next); setJobs(history); setError("");
      setSelected((current) => current && next.files.some((file) => file.path === current.path && (current.area === "staged" ? file.index !== "." && file.index !== "?" : file.working !== ".")) ? current : null);
    } catch (reason) { if (alive.current && version === loadVersion.current) setError(messageOf(reason)); }
  }, [api, workspace.id]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  useEffect(() => {
    let canceled = false; setDiff(null);
    if (status && selected) void api.scmDiff(workspace.id, selected.path, selected.area, status.revision).then((result) => { if (!canceled) setDiff(result); }).catch((reason) => { if (!canceled) setError(messageOf(reason)); });
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
          activeJob.current = null; await refresh();
        } else timer = setTimeout(() => void poll(), 400);
      } catch (reason) { if (!canceled) { setError(messageOf(reason)); timer = setTimeout(() => void poll(), 1500); } }
    };
    timer = setTimeout(() => void poll(), 200); return () => { canceled = true; clearTimeout(timer); };
  }, [api, workspace.id, running, refresh]);
  const act = async (action: ScmAction, paths?: string[]) => {
    if (!status || busy) return; setPending(true); setError("");
    try {
      const job = await api.startScm(workspace.id, { requestId: crypto.randomUUID(), expectedRevision: status.revision, action, ...(paths ? { paths } : {}), ...(action === "commit" ? { message } : {}) });
      activeJob.current = job.id; if (alive.current) setJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)]);
    } catch (reason) { if (alive.current) setError(messageOf(reason)); }
    finally { if (alive.current) setPending(false); }
  };
  const section = (title: string, area: ScmArea, files: ScmFile[]) => <section className={`scm-file-section ${area}`}>
    <header><strong>{title} <span>{files.length}</span></strong>{files.length ? <button className="text-button scm-all" disabled={busy} onClick={() => void act(area === "staged" ? "unstage" : "stage", files.map((file) => file.path))}>{area === "staged" ? "모두 취소" : "모두 스테이징"}</button> : null}</header>
    {files.map((file) => <div className={`scm-file${selected?.path === file.path && selected.area === area ? " selected" : ""}`} key={file.path}>
      <button className="scm-file-select" title={file.path} data-path={file.path} data-area={area} onClick={() => setSelected({ path: file.path, area })}><span className={file.conflicted ? "scm-conflict" : ""}>{file.conflicted ? "!" : area === "staged" ? file.index : file.working}</span><span>{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</span></button>
      <button className="text-button scm-file-action" aria-label={`${file.path} ${area === "staged" ? "스테이징 취소" : "스테이징"}`} disabled={busy} onClick={() => void act(area === "staged" ? "unstage" : "stage", [file.path])}>{area === "staged" ? "−" : "+"}</button>
    </div>)}
    {!files.length ? <p className="muted">변경 없음</p> : null}
  </section>;
  const staged = status?.files.filter((file) => file.index !== "." && file.index !== "?" && !file.conflicted) ?? [];
  const working = status?.files.filter((file) => file.working !== "." || file.conflicted) ?? [];
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="scm-dialog" role="dialog" aria-modal="true" aria-label="Git 변경 검토">
    <header className="scm-header"><div><h2>Git 변경 검토</h2><p><strong>{status?.branch ?? (status?.head ? "분리된 HEAD" : workspace.label)}</strong>{status?.head ? ` · ${status.head.slice(0, 8)}` : " · 첫 커밋 전"}{status?.operation ? ` · ${status.operation} 진행 중` : ""}</p><small title={status?.root}>{status?.root ?? workspace.cwd}</small>{status?.upstream ? <small>{status.upstream} · 보낼 커밋 {status.ahead} · 받을 커밋 {status.behind}</small> : null}</div><button className="button scm-refresh" disabled={busy} onClick={() => void refresh()}>새로고침</button><button className="button scm-close" onClick={onClose}>닫기</button></header>
    {error ? <p className="scm-error" role="alert">{error}</p> : null}
    <div className="scm-body"><aside className="scm-sidebar">{status ? <>{section("스테이징된 변경", "staged", staged)}{section("작업 폴더 변경", "working", working)}</> : <p>변경을 불러오는 중…</p>}
      <form className="scm-commit-form" onSubmit={(event) => { event.preventDefault(); void act("commit"); }}><label htmlFor="scm-message">커밋 내용</label><textarea id="scm-message" value={message} maxLength={32000} placeholder="무엇을 왜 바꿨는지" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (message.trim() && staged.length) void act("commit"); } }} /><small>스테이징한 변경을 커밋합니다. 저장소의 검사 훅도 실행됩니다.</small><button className="button primary scm-commit" disabled={busy || !message.trim() || (!staged.length && status?.operation !== "merge") || status?.files.some((file) => file.conflicted)}>커밋</button></form>
    </aside><main className={`scm-review${wrap ? " wrap" : ""}`}>
      {selected ? <><header className="scm-diff-header"><strong>{selected.path}</strong><span>{selected.area === "staged" ? "HEAD → 스테이징" : "스테이징 → 작업 파일"}</span><label><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />줄바꿈</label></header>{diff ? <>{diff.images ? <><div className="scm-image-tools"><button className="button small" onClick={() => setImageMode(imageMode === "side" ? "overlay" : "side")}>{imageMode === "side" ? "겹쳐 보기" : "나란히 보기"}</button><span>이전 / 이후 · 최대 8 MiB</span></div><div className={`scm-images ${imageMode}`}>{(["before", "after"] as const).map((side) => <figure key={side}>{diff.images![side] ? <img src={diff.images![side]!} alt={side === "before" ? "이전 이미지" : "이후 이미지"} /> : <span>이미지 없음 또는 크기 제한</span>}<figcaption>{side === "before" ? "이전" : "이후"}</figcaption></figure>)}</div></> : null}{diff.truncated ? <p className="scm-warning">변경이 커서 앞부분만 표시합니다. 전체 파일을 확인한 뒤 스테이징하세요.</p> : null}<DiffLines patch={diff.patch || "이 영역의 변경이 없습니다."} /></> : <p className="scm-placeholder">차이를 불러오는 중…</p>}</> : <p className="scm-placeholder">파일을 선택해 변경을 검토하세요.</p>}
    </main></div>
    <footer className="scm-history"><h3>Git 작업 기록</h3>{jobs.slice(0, 12).map((job, index) => <details key={job.id} open={index === 0}><summary><strong>{actionLabels[job.request.action]}</strong> · <span className={`scm-phase ${job.phase}`}>{phaseLabels[job.phase]}</span> · {job.branch ?? "분리된 HEAD"} · {new Date(job.createdAt).toLocaleTimeString()}{job.headAfter && job.headAfter !== job.headBefore ? ` · ${job.headAfter.slice(0, 8)}` : ""}</summary>{job.phase === "running" ? <button className="button small scm-interrupt" onClick={() => void api.interruptScm(job.id).then(() => refresh()).catch((reason) => setError(messageOf(reason)))}>중단 · 변경은 현재 상태 유지</button> : null}{job.error ? <p className="scm-error">{job.error}</p> : null}{job.request.message ? <p>{job.request.message}</p> : null}{job.outputTruncated ? <small>최근 출력만 표시합니다.</small> : null}{job.output ? <pre>{job.output}</pre> : <small>{job.phase === "running" ? "Git 응답을 기다리는 중…" : "추가 출력 없음"}</small>}</details>)}{!jobs.length ? <small>아직 실행한 Git 작업이 없습니다.</small> : null}</footer>
  </div></div>;
}
