import { useEffect, useRef, useState } from "react";
import type { GitHubActionJob, GitHubRecoveryPreview, GitHubView } from "@workbench/contracts";
import type { Api } from "../api.ts";

export function GitHubRecovery({ api, workspaceId, view, job, disabled, updated }: { api: Api; workspaceId: string; view: GitHubView; job: GitHubActionJob; disabled: boolean; updated: (job: GitHubActionJob) => void }) {
  const [preview, setPreview] = useState<GitHubRecoveryPreview | null>(null), [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), panel = useRef<HTMLElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // History polling may first catch up to the revision returned by our own preview read.
  useEffect(() => { if (preview && preview.job.updatedAt !== job.updatedAt) { setPreview(null); setChecked(false); } }, [job.updatedAt]);
  useEffect(() => { if (preview) panel.current?.scrollIntoView?.({ block: "nearest" }); }, [preview]);
  const prepare = async () => {
    setBusy(true); setError(""); setPreview(null); setChecked(false);
    try {
      const context = await api.githubActionContext(workspaceId, view), next = await api.githubRecoveryPreview(workspaceId, job.id, context.id);
      if (alive.current) setPreview(next);
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(false); }
  };
  const acknowledge = async () => {
    if (!preview || !checked) return; setBusy(true); setError("");
    try { const next = await api.githubRecoveryAcknowledge(workspaceId, job.id, preview.id); if (alive.current) { setPreview(null); updated(next); } }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(false); }
  };
  if (job.recovery) return <p className="scm-gh-recovery-record">{job.recovery.actor} · {new Date(job.recovery.acknowledgedAt).toLocaleString()} · 미확정 당시 기록을 보존하고 다른 작업 허용</p>;
  if (!job.effects.some((effect) => effect.phase === "uncertain") || job.effects.some((effect) => ["prepared", "sending", "accepted", "pending"].includes(effect.phase))) return null;
  const original = preview?.job.preview, action = original?.action;
  return <div className="scm-gh-recovery">
    <button className="button small scm-gh-recovery-open" disabled={disabled || busy || view.stale} onClick={() => void prepare()}>미확정 기록 검토</button>
    {error ? <p role="alert" className="scm-error">{error}</p> : null}
    {preview && original ? <section ref={panel} className="scm-gh-recovery-preview" aria-label="미확정 요청 확인">
      <strong>{preview.actor} · {preview.repo}{preview.number ? ` #${preview.number}` : " · 새 PR"}</strong>
      <p>현재 PR · {preview.headOid.slice(0, 12)} → {preview.baseBranch}</p>
      <p>원래 요청 · {original.headRepo}:{original.headBranch} → {original.baseBranch} · {original.headOid.slice(0, 12)}</p>
      <p>원래 요청 · {new Date(preview.job.createdAt).toLocaleString()}</p>
      {preview.job.effects.map((effect) => <p key={effect.id}>{effect.label} — {effect.detail}</p>)}
      {action?.kind === "create" || action?.kind === "edit" ? <><strong>{action.title}</strong><pre>{action.body}</pre></> : null}
      {action && "method" in action ? <p>병합 방법: {action.method}</p> : null}
      {action?.kind === "discussion" ? <>
        {"body" in action.operation ? <pre>{action.operation.body}</pre> : null}
        {"event" in action.operation ? <p>리뷰 결과: {action.operation.event === "APPROVE" ? "승인" : action.operation.event === "REQUEST_CHANGES" ? "변경 요청" : "의견"}</p> : null}
        {action.operation.kind === "review" ? action.operation.comments.map((comment, i) => <pre key={i}>{comment.body}</pre>) : null}
        {action.operation.kind === "reaction" ? <p>반응: {action.operation.content} · {action.operation.add ? "추가" : "취소"}</p> : null}
        {action.operation.kind === "resolve" ? <p>{action.operation.resolved ? "해결 표시" : "다시 열기"}</p> : null}
      </> : null}
      {original.evidence?.map((item, i) => <pre key={i}>{item}</pre>)}
      {preview.notices.map((notice, i) => <p className="scm-warning" key={i}>{notice}</p>)}
      <a href={`https://github.com/${preview.repo}${preview.number ? `/pull/${preview.number}` : "/pulls"}`} target="_blank" rel="noreferrer">GitHub에서 현재 상태 열기</a>
      <label><input className="scm-gh-recovery-check" type="checkbox" checked={checked} disabled={busy || disabled} onChange={(event) => setChecked(event.target.checked)} />결과가 미확정이며 나중에 반영될 수 있음을 확인했습니다.</label>
      <button className="button scm-gh-recovery-confirm" disabled={!checked || busy || disabled || view.stale} onClick={() => void acknowledge()}>미확정으로 보관하고 다른 작업 허용</button>
      <button className="button small" disabled={busy} onClick={() => setPreview(null)}>취소</button>
    </section> : null}
  </div>;
}
