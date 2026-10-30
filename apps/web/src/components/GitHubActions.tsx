import { useEffect, useRef, useState } from "react";
import type { GitHubActionContext, GitHubActionInput, GitHubActionJob, GitHubActionPreview, GitHubDraft, GitHubMergeMethod, GitHubTemplate, GitHubView } from "@workbench/contracts";
import type { Api } from "../api.ts";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const phases: Record<GitHubActionJob["phase"], string> = { running: "전송 중", pending: "원격 처리 중", complete: "요청 결과 확인", partial: "일부 처리됨", failed: "실패", uncertain: "결과 확인 필요", changed: "기준 변경됨" };
export function GitHubActions({ api, workspaceId, view, disabled, refresh }: { api: Api; workspaceId: string; view: GitHubView; disabled: boolean; refresh: (number?: number) => void }) {
  const [open, setOpen] = useState(false), [context, setContext] = useState<GitHubActionContext | null>(null), [draft, setDraft] = useState<GitHubDraft | null>(null), [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<GitHubActionPreview | null>(null), [jobs, setJobs] = useState<GitHubActionJob[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState("");
  const [method, setMethod] = useState<GitHubMergeMethod>("squash"), [checks, setChecks] = useState<string[]>([]);
  const [templates, setTemplates] = useState<GitHubTemplate[] | null>(null);
  const previewElement = useRef<HTMLElement>(null);
  useEffect(() => { if (preview) previewElement.current?.scrollIntoView?.({ block: "nearest" }); }, [preview]);
  const alive = useRef(true), generation = useRef(0), draftRef = useRef<GitHubDraft | null>(null), contextRef = useRef<GitHubActionContext | null>(null), saveChain = useRef(Promise.resolve()), requestId = useRef("");
  const save = (value: GitHubDraft) => {
    draftRef.current = value; setDraft(value); setSaved("저장 중…");
    const ctx = contextRef.current; if (!ctx) return Promise.resolve();
    const pending = saveChain.current.then(async () => {
      const result = await api.githubDraftSave(workspaceId, ctx.id, { ...value, version: draftRef.current?.version ?? value.version });
      if (draftRef.current) draftRef.current = { ...draftRef.current, version: result.version };
      if (alive.current) { setDraft(draftRef.current); setSaved("초안 저장됨"); }
    });
    saveChain.current = pending.catch((reason) => { if (alive.current) { setSaved("초안 저장 실패"); setError(message(reason)); } }); return pending;
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const list = async () => { const next = await api.githubActionJobs(workspaceId); if (alive.current) setJobs(next); return next; };
  const inspect = async () => {
    setOpen(true); setBusy(true); setError(""); setPreview(null); const version = ++generation.current;
    try {
      await saveChain.current;
      const next = await api.githubActionContext(workspaceId, view), stored = await api.githubDraft(workspaceId, next.id);
      if (!alive.current || version !== generation.current) return;
      contextRef.current = next; draftRef.current = stored; setContext(next); setDraft(stored); setSaved(stored.version ? "초안 저장됨" : ""); setMethod(next.defaultMethod); setChecks([]); setEditing(!next.number); await list();
    } catch (reason) { if (alive.current && version === generation.current) { setError(message(reason)); await list().catch(() => {}); } }
    finally { if (alive.current && version === generation.current) setBusy(false); }
  };
  useEffect(() => {
    if (!open || !jobs.some((job) => job.phase === "running" || job.phase === "pending")) return;
    let canceled = false;
    const timer = setTimeout(async () => {
      try {
        const active = jobs.filter((job) => job.phase === "running" || job.phase === "pending");
        const updates = await Promise.all(active.map((job) => api.githubActionJob(workspaceId, job.id, job.phase === "pending")));
        if (!canceled) setJobs((old) => old.map((job) => updates.find((next) => next.id === job.id) ?? job));
      } catch (reason) { if (!canceled) setError(message(reason)); }
    }, 3000);
    return () => { canceled = true; clearTimeout(timer); };
  }, [api, workspaceId, jobs, open]);
  const prepare = async (action: GitHubActionInput) => {
    if (!context) return; setBusy(true); setError(""); setPreview(null);
    try { await saveChain.current; const next = await api.githubActionPreview(workspaceId, context.id, action); if (alive.current) { requestId.current = crypto.randomUUID(); setPreview(next); } }
    catch (reason) { if (alive.current) setError(message(reason)); }
    finally { if (alive.current) setBusy(false); }
  };
  const execute = async () => {
    if (!preview) return; setBusy(true); setError("");
    try { const job = await api.githubActionStart(workspaceId, preview.id, requestId.current); if (alive.current) { setJobs((old) => [job, ...old.filter((item) => item.id !== job.id)]); setPreview(null); } }
    catch (reason) { if (alive.current) { setError(`${message(reason)} 실행 기록에서 전송 결과를 확인하세요.`); await list().catch(() => {}); } }
    finally { if (alive.current) setBusy(false); }
  };
  const checkRemote = async (job: GitHubActionJob) => {
    setBusy(true); setError(""); try { const next = await api.githubActionJob(workspaceId, job.id, true); if (alive.current) setJobs((old) => old.map((item) => item.id === next.id ? next : item)); } catch (reason) { if (alive.current) setError(message(reason)); } finally { if (alive.current) setBusy(false); }
  };
  const changeDraft = (patch: Partial<GitHubDraft>) => { if (draftRef.current) { setPreview(null); void save({ ...draftRef.current, ...patch }).catch(() => {}); } };
  const canAct = !!context && !disabled && !busy && !view.stale;
  return <section className="scm-gh-write" aria-label="PR 작업">
    <div className="scm-gh-actions"><button className="button scm-gh-manage" disabled={disabled || busy || view.stale || !view.pull && !!view.candidates.length} onClick={() => void inspect()}>{view.pull ? "PR 작업 열기" : "PR 작성"}</button><button className="button small scm-gh-history" disabled={busy} onClick={() => { setOpen(true); void list().catch((reason) => setError(message(reason))); }}>실행 기록</button>{open ? <button className="button small" onClick={() => setOpen(false)}>작업 접기</button> : null}</div>
    {open ? <>
      {error ? <p role="alert" className="scm-error scm-gh-action-error">{error}</p> : null}
      {context ? <>
        <p className="scm-gh-actor">{context.actor} · {context.headRepo}:{context.headBranch} → {context.repo}:{context.baseBranch} · {context.headOid.slice(0, 12)}</p>
        {context.notices.map((note, i) => <p className="scm-warning" key={i}>{note}</p>)}
        {context.number && !editing ? <button className="button small scm-gh-edit" disabled={!canAct || !context.canUpdate || context.state === "merged"} onClick={() => setEditing(true)}>제목·설명 수정</button> : null}
        {editing && draft ? <form className="scm-gh-composer" onSubmit={(event) => { event.preventDefault(); void prepare(context.number ? { kind: "edit", title: draft.title, body: draft.body, baseBranch: draft.baseBranch } : { kind: "create", title: draft.title, body: draft.body, baseBranch: draft.baseBranch, draft: draft.draft, maintainerCanModify: draft.maintainerCanModify }); }}>
          <label>PR 제목<input className="scm-gh-title" value={draft.title} maxLength={1024} disabled={busy} onChange={(event) => changeDraft({ title: event.target.value })} /></label>
          <label>기준 브랜치<input className="scm-gh-base-branch" value={draft.baseBranch} disabled={busy} onChange={(event) => changeDraft({ baseBranch: event.target.value })} /></label>
          <label>PR 설명<textarea className="scm-gh-body" value={draft.body} rows={8} disabled={busy} onChange={(event) => changeDraft({ body: event.target.value })} /></label>
          <button className="button small scm-gh-templates" type="button" disabled={!canAct} onClick={() => { setBusy(true); void api.githubTemplates(workspaceId, view).then(setTemplates).catch((reason) => setError(message(reason))).finally(() => setBusy(false)); }}>현재 커밋의 PR 템플릿 보기</button>
          {templates ? <div className="scm-gh-template-list">{templates.length ? templates.map((template) => <details key={template.path}><summary>{template.path} · {template.commit.slice(0, 12)}</summary><pre>{template.body}</pre><button type="button" className="button scm-gh-template-apply" disabled={!canAct} onClick={() => changeDraft({ body: `${draftRef.current?.body ?? ""}${draftRef.current?.body ? "\n\n" : ""}${template.body}` })}>설명에 추가</button></details>) : <p>현재 커밋에 Markdown PR 템플릿이 없습니다.</p>}</div> : null}
          {!context.number ? <><label><input type="checkbox" checked={draft.draft} disabled={busy} onChange={(event) => changeDraft({ draft: event.target.checked })} />초안 PR</label><label><input type="checkbox" checked={draft.maintainerCanModify} disabled={busy} onChange={(event) => changeDraft({ maintainerCanModify: event.target.checked })} />원본 저장소 관리자의 브랜치 수정 허용</label></> : null}
          <span className="scm-gh-draft-state" role="status">{saved}</span><button className="button scm-gh-compose-preview" disabled={!canAct || !draft.title.trim() || !draft.baseBranch.trim()}>실행 내용 확인</button>
        </form> : null}
        {context.number && context.state !== "merged" ? <>
          <div className="scm-gh-actions"><button className="button small scm-gh-state" disabled={!canAct || !context.canUpdate} onClick={() => void prepare({ kind: context.state === "closed" ? "reopen" : "close" })}>{context.state === "closed" ? "PR 다시 열기" : "PR 닫기"}</button>{context.state === "open" ? <button className="button small scm-gh-ready" disabled={!canAct || !context.canUpdate} onClick={() => void prepare({ kind: context.draft ? "ready" : "draft" })}>{context.draft ? "검토 준비 완료로 전환" : "초안으로 전환"}</button> : null}</div>
          {context.state === "open" ? <>
            <fieldset className="scm-gh-merge" disabled={!canAct || !context.canMerge || context.draft || context.queued}><legend>병합</legend>{!context.queueRequired ? context.methods.map((value) => <label key={value}><input type="radio" name="github-merge-method" checked={method === value} onChange={() => { setMethod(value); setPreview(null); }} />{value === "merge" ? "병합 커밋" : value === "squash" ? "커밋 하나로 합치기" : "리베이스"}</label>) : <p>대기열은 저장소에 설정된 병합 방법을 사용합니다.</p>}<button className="button scm-gh-merge-preview" disabled={!context.methods.length} onClick={() => void prepare(context.queueRequired ? { kind: "enqueue" } : { kind: "merge", method })}>{context.queueRequired ? "병합 대기열 등록 확인" : "병합 내용 확인"}</button>{context.autoAllowed && !context.autoEnabled && !context.queueRequired && !context.stack ? <button className="button scm-gh-auto" onClick={() => void prepare({ kind: "auto-enable", method })}>자동 병합 설정 확인</button> : null}</fieldset>
            {context.autoEnabled ? <button className="button scm-gh-auto-disable" disabled={!canAct} onClick={() => void prepare({ kind: "auto-disable" })}>자동 병합 해제 확인</button> : null}
            <details className="scm-gh-reruns"><summary>검사 재실행</summary><p>선택하지 않으면 표시된 재실행 가능 검사를 대상으로 합니다. 같은 Actions 실행은 한 번만 요청합니다.</p>{view.checks.filter((check) => check.details).map((check) => <label key={check.id}><input type="checkbox" disabled={!canAct} checked={checks.includes(check.id)} onChange={(event) => { setPreview(null); setChecks((old) => event.target.checked ? [...old, check.id] : old.filter((id) => id !== check.id)); }} />{check.name} · {check.source === "merge" ? "시험 병합" : "PR"}</label>)}<div className="scm-gh-actions"><button className="button scm-gh-rerun-failed" disabled={!canAct} onClick={() => void prepare({ kind: "rerun", failedOnly: true, checks })}>실패한 작업 재실행 확인</button><button className="button scm-gh-rerun-all" disabled={!canAct} onClick={() => void prepare({ kind: "rerun", failedOnly: false, checks })}>전체 작업 재실행 확인</button></div></details>
          </> : null}
        </> : null}
      </> : null}
      {preview ? <section ref={previewElement} className="scm-gh-action-preview" aria-label="실행할 GitHub 작업"><strong>{preview.actor} · {preview.repo}{preview.number ? ` #${preview.number}` : " · 새 PR"}</strong><p>{preview.headRepo}:{preview.headBranch} → {preview.baseBranch} · {preview.headOid.slice(0, 12)}</p><ul>{preview.effects.map((effect, i) => <li key={i}>{effect}</li>)}</ul>{preview.action.kind === "create" || preview.action.kind === "edit" ? <><strong>{preview.action.title}</strong><pre>{preview.action.body}</pre></> : null}{"method" in preview.action ? <p>병합 방법: {preview.action.method}</p> : null}{preview.notices.map((notice, i) => <p className="scm-warning" key={i}>{notice}</p>)}<button className="button primary scm-gh-execute" disabled={disabled || busy || view.stale} onClick={() => void execute()}>이 내용으로 실행</button><button className="button" disabled={busy} onClick={() => setPreview(null)}>취소</button></section> : null}
      {jobs.length ? <details className="scm-gh-journal" open><summary>GitHub 실행 기록 {jobs.length}</summary>{jobs.map((job) => <article className="scm-gh-action-job" key={job.id} data-phase={job.phase}><strong>{job.preview.repo}{job.preview.number ? ` #${job.preview.number}` : " 새 PR"} · {phases[job.phase]}</strong><small>{new Date(job.createdAt).toLocaleString()}</small>{job.effects.map((effect) => <p key={effect.id}>{effect.label} — {effect.detail}{effect.url ? <> <a href={effect.url} target="_blank" rel="noreferrer">PR 열기</a></> : null}</p>)}<button className="button small scm-gh-reconcile" disabled={busy || job.phase === "running"} onClick={() => void checkRemote(job)}>원격 결과 확인</button><button className="button small scm-gh-result-refresh" disabled={disabled || busy} onClick={() => { setContext(null); contextRef.current = null; setPreview(null); refresh(job.effects.find((effect) => effect.number)?.number ?? job.preview.number ?? undefined); }}>PR·CI에 반영</button></article>)}</details> : null}
    </> : null}
  </section>;
}
