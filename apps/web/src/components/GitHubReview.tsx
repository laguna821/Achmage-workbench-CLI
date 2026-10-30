import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubBinding, GitHubCheckDetails, GitHubLog, GitHubSelection, GitHubView } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { ScmDiffText } from "./ScmDiffText.tsx";
import { GitHubActions } from "./GitHubActions.tsx";
import { GitHubDiscussion } from "./GitHubDiscussion.tsx";
import { GitHubMarkdown as Text } from "./GitHubMarkdown.tsx";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const labels: Record<string, string> = { renamed: "이름 변경", added: "추가", removed: "삭제", modified: "수정", copied: "복사", changed: "변경", open: "열림", closed: "닫힘", merged: "병합됨", success: "성공", failure: "실패", error: "오류", action_required: "승인 필요", cancelled: "취소됨", timed_out: "시간 초과", skipped: "건너뜀", neutral: "중립", queued: "대기", pending: "대기", in_progress: "실행 중", completed: "완료", waiting: "대기", stale: "오래됨" };
export function GitHubReview({ api, workspaceId, refreshEpoch }: { api: Api; workspaceId: string; refreshEpoch: number }) {
  const [binding, setBinding] = useState<GitHubBinding | null>(null), [head, setHead] = useState(""), [base, setBase] = useState(""), [number, setNumber] = useState("");
  const [view, setView] = useState<GitHubView | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [section, setSection] = useState<"files" | "checks" | "discussion">("files"), [filePath, setFilePath] = useState<string | null>(null), [wrap, setWrap] = useState(false), [fixEpoch, setFixEpoch] = useState(0);
  const [detail, setDetail] = useState<GitHubCheckDetails | null>(null), [log, setLog] = useState<GitHubLog | null>(null), [detailError, setDetailError] = useState(""), [detailBusy, setDetailBusy] = useState(false);
  const logElement = useRef<HTMLElement>(null);
  useEffect(() => { if (log) logElement.current?.scrollIntoView({ block: "nearest" }); }, [log]);
  const generation = useRef(0), detailGeneration = useRef(0), selection = useRef({ head, base, number }); selection.current = { head, base, number };
  const clearDetail = () => { detailGeneration.current++; setDetail(null); setLog(null); setDetailError(""); setDetailBusy(false); };
  const load = useCallback(async (current: GitHubBinding, selected: { head: string; base: string; number: string }, fresh: boolean) => {
    const version = ++generation.current; clearDetail(); setPending(true); setError("");
    const request: GitHubSelection = { binding: current.revision, head: selected.head, base: selected.base, fresh, ...(selected.number ? { number: Number(selected.number) } : {}) };
    try { const next = await api.githubLoad(workspaceId, request); if (generation.current !== version) return; setView(next); setFilePath((path) => next.files.find((file) => file.path === path)?.path ?? next.files[0]?.path ?? null); }
    catch (reason) { if (generation.current === version) { setError(message(reason)); setView((old) => old ? { ...old, stale: true, error: message(reason) } : null); } }
    finally { if (generation.current === version) setPending(false); }
  }, [api, workspaceId]);
  useEffect(() => {
    let canceled = false; const version = ++generation.current; setPending(true); setError("");
    void api.githubBinding(workspaceId).then(async (next) => {
      if (canceled || generation.current !== version) return;
      const old = selection.current, selected = { head: next.heads.some((item) => item.id === old.head) ? old.head : next.defaultHead ?? "", base: next.bases.some((item) => item.id === old.base) ? old.base : next.defaultBase ?? "", number: old.number };
      setBinding(next); setHead(selected.head); setBase(selected.base); setView(null); clearDetail();
      if (selected.head && selected.base) await load(next, selected, refreshEpoch > 0); else setPending(false);
    }).catch((reason) => { if (!canceled && generation.current === version) { setError(message(reason)); setPending(false); } });
    return () => { canceled = true; generation.current++; detailGeneration.current++; };
  }, [api, workspaceId, refreshEpoch, load]);
  useEffect(() => {
    if (!binding || !view?.pull || pending || view.stale || section === "discussion") return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(binding, { head: view.head.id, base: view.base.id, number: String(view.pull!.number) }, false); }, 60000);
    return () => clearInterval(timer);
  }, [binding, view, pending, load, section]);
  const choose = (kind: "head" | "base", value: string) => { generation.current++; clearDetail(); setView(null); setError(""); setNumber(""); if (kind === "head") setHead(value); else setBase(value); };
  const inspect = async (item: string) => {
    if (!view) return; clearDetail(); const version = ++detailGeneration.current; setDetailBusy(true);
    try { const next = await api.githubCheck(workspaceId, view, item); if (version === detailGeneration.current) setDetail(next); }
    catch (reason) { if (version === detailGeneration.current) setDetailError(message(reason)); }
    finally { if (version === detailGeneration.current) setDetailBusy(false); }
  };
  const readLog = async (item: string) => {
    if (!view) return; const version = ++detailGeneration.current; setDetailBusy(true); setLog(null); setDetailError("");
    try { const next = await api.githubLog(workspaceId, view, item); if (version === detailGeneration.current) setLog(next); }
    catch (reason) { if (version === detailGeneration.current) setDetailError(message(reason)); }
    finally { if (version === detailGeneration.current) setDetailBusy(false); }
  };
  const file = view?.files.find((entry) => entry.path === filePath), pull = view?.pull;
  return <section className="scm-github" aria-label="GitHub PR·CI">
    <details className="scm-gh-binding" open={!view || !!error}>
      <summary>PR 연결 · {binding?.branch ?? "브랜치 확인 중"}{view ? ` · ${view.head.repo}:${view.head.branch} → ${view.base.repo}` : ""}</summary>
      {binding ? <><div className="scm-gh-targets">{(["head", "base"] as const).map((kind) => <fieldset key={kind} disabled={pending}><legend>{kind === "head" ? "작업을 보낸 저장소·브랜치" : "PR을 받는 저장소"}</legend>{binding[kind === "head" ? "heads" : "bases"].map((item) => <label key={item.id}><input type="radio" className={`scm-gh-${kind}`} name={`github-${kind}`} value={item.id} checked={(kind === "head" ? head : base) === item.id} onChange={() => choose(kind, item.id)} />{item.repo}{item.branch ? `:${item.branch}` : ""} <small>({item.remote})</small></label>)}</fieldset>)}</div>{binding.warnings.map((note, i) => <p className="scm-warning" key={i}>{note}</p>)}</> : null}
    </details>
    <form className="scm-gh-actions" onSubmit={(event) => { event.preventDefault(); if (binding) void load(binding, { head, base, number }, true); }}><label>PR 번호 <input className="scm-gh-number" inputMode="numeric" pattern="[1-9][0-9]*" placeholder="열린 PR 찾기" value={number} disabled={pending} onChange={(event) => { setNumber(event.target.value); }} /></label><button className="button scm-gh-load" disabled={!head || !base || pending}>{pending ? "확인 중…" : "PR·CI 새로고침"}</button>{view ? <small>조회 {new Date(view.checkedAt).toLocaleTimeString()}</small> : null}</form>
    {error ? <p role="alert" className="scm-error">{error}</p> : null}
    {view?.stale ? <p role="alert" className="scm-warning scm-gh-stale">마지막으로 확인한 정보를 표시합니다. {view.error}</p> : null}
    {view?.notices.map((note, i) => <p key={i} className="scm-warning">{note}</p>)}
    {view ? <GitHubActions key={`${workspaceId}:${head}:${base}:${view.pull?.number ?? "new"}`} api={api} workspaceId={workspaceId} view={view} disabled={pending} refresh={(selected) => { if (!binding) return; const next = selected ? String(selected) : number; setNumber(next); void load(binding, { head, base, number: next }, true); }} /> : null}
    {view && !pull ? <div className="scm-gh-empty">{view.candidates.length ? <><p>이 브랜치의 PR을 선택하세요.</p>{view.candidates.map((item) => <button key={item.number} className="button scm-gh-candidate" disabled={pending} onClick={() => { setNumber(String(item.number)); if (binding) void load(binding, { head, base, number: String(item.number) }, true); }}>#{item.number} {item.title}</button>)}</> : <p>이 저장소·브랜치의 열린 PR이 없습니다. 닫힌 PR은 번호로 확인할 수 있습니다.</p>}</div> : null}
    {pull && view ? <><header className="scm-gh-pull"><h3>#{pull.number} {pull.title}</h3><p>{pull.draft ? "초안 · " : ""}{labels[pull.state]} · {pull.author} · {pull.headBranch} → {pull.baseBranch} <a href={pull.url} target="_blank" rel="noreferrer">GitHub에서 열기</a></p><small>PR {pull.headOid.slice(0, 12)} · 기준 {pull.baseOid.slice(0, 12)}</small>{view.localHead !== pull.headOid ? <p className="scm-warning">현재 로컬 커밋({view.localHead?.slice(0, 12) ?? "없음"})과 PR 커밋이 다릅니다. 아래는 GitHub에 올라간 변경입니다.</p> : null}{pull.body ? <details><summary>PR 설명</summary><Text>{pull.body}</Text></details> : null}</header>
      <nav className="scm-review-tabs" aria-label="PR 검토 보기"><button className={`button scm-gh-files-tab${section === "files" ? " primary" : ""}`} aria-pressed={section === "files"} onClick={() => setSection("files")}>변경 파일 {pull.changedFiles}</button><button className={`button scm-gh-checks-tab${section === "checks" ? " primary" : ""}`} aria-pressed={section === "checks"} onClick={() => setSection("checks")}>검사 {view.checks.length}</button><button className={`button scm-gh-discussion-tab${section === "discussion" ? " primary" : ""}`} aria-pressed={section === "discussion"} onClick={() => setSection("discussion")}>리뷰 대화</button></nav>
      {section === "files" ? <div className="scm-body"><aside className="scm-sidebar">{view.files.map((entry) => <button key={entry.id} className={`scm-compare-file scm-gh-file${filePath === entry.path ? " selected" : ""}`} data-path={entry.path} onClick={() => setFilePath(entry.path)}><span>{entry.path}</span><small>{labels[entry.status] ?? entry.status} · +{entry.additions} −{entry.deletions}</small></button>)}</aside><main className={`scm-review${wrap ? " wrap" : ""}`}>{file ? <><header className="scm-diff-header"><strong>{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</strong><label><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />줄바꿈</label></header>{file.notice ? <p className="scm-warning">{file.notice}</p> : null}{file.patch ? <ScmDiffText diff={{ path: file.path, area: "working", revision: `${view.revision}:${file.id}`, patch: file.patch, truncated: !!file.notice, binary: false }} /> : null}</> : <p className="scm-placeholder">검토할 파일을 선택하세요.</p>}</main></div> : section === "checks" ? <div className="scm-gh-checks">
        <button className="button small scm-gh-fix-checks" disabled={pending || view.stale} onClick={() => { setFixEpoch((n) => n + 1); setSection("discussion"); }}>실패 검사 수정 요청</button>
        {!view.checks.length ? <p>표시할 검사 결과가 없습니다. 병합 가능 여부를 뜻하지 않습니다.</p> : null}
        <div className="scm-gh-check-list">{view.checks.map((check) => <article className="scm-gh-check" key={check.id}><strong>{check.name}</strong><span className={`scm-gh-outcome ${check.conclusion ?? check.status}`}>{labels[check.conclusion ?? check.status] ?? check.conclusion ?? check.status}</span><small>{check.source === "merge" ? "시험 병합" : "PR"} {check.oid.slice(0, 12)}</small>{check.details ? <button className="button small scm-gh-detail" disabled={detailBusy || pending} onClick={() => void inspect(check.id)}>상세·로그</button> : null}{check.url ? <a href={check.url} target="_blank" rel="noreferrer">검사 열기</a> : null}</article>)}</div>
        {detailError ? <p role="alert" className="scm-error">{detailError}</p> : null}{detailBusy ? <p>검사 정보를 읽는 중…</p> : null}
        {detail ? <section className="scm-gh-details"><h4>{detail.name}</h4>{detail.summary ? <Text>{detail.summary}</Text> : null}{detail.text ? <Text>{detail.text}</Text> : null}{detail.notices.map((note, i) => <p className="scm-warning" key={i}>{note}</p>)}{detail.jobs.map((job) => <article key={job.id}><strong>{job.name} · {labels[job.conclusion ?? job.status] ?? job.status}</strong><ol>{job.steps.map((step, i) => <li key={i}>{step.name} · {labels[step.conclusion ?? step.status] ?? step.status}</li>)}</ol><button className="button scm-gh-log-button" disabled={detailBusy || job.status !== "completed"} onClick={() => void readLog(job.id)}>작업 로그 읽기</button></article>)}</section> : null}
        {log ? <section ref={logElement} className="scm-gh-log"><h4>{log.name} 로그</h4>{log.truncated ? <p className="scm-warning">로그의 마지막 부분만 표시합니다.</p> : null}<pre>{log.text || "로그 내용이 비어 있습니다."}</pre></section> : null}
      </div> : null}
      <GitHubDiscussion key={`${workspaceId}:${head}:${base}:${pull.number}`} api={api} workspaceId={workspaceId} view={view} active={section === "discussion"} disabled={pending} fixEpoch={fixEpoch} />
    </> : null}
  </section>;
}
