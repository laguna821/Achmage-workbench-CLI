import { useEffect, useState } from "react";
import type { ScmConflict, ScmConflictVersion, ScmResolution, ScmStatus } from "@workbench/contracts";
import type { Api } from "../api.ts";

export const conflictDraftKey = (workspaceId: string, path: string) => `scm-conflict-draft:${workspaceId}:${encodeURIComponent(path)}`;
type Draft = { revision: string; content: string };
const hasMarkers = (text: string, size: number) => new RegExp(`^(?:<{${size},}|\\|{${size},}|={${size},}|>{${size},})(?:[^\\r\\n]*)\\r?$`, "m").test(text);
function Version({ value }: { value: ScmConflictVersion }) {
  if (value.kind === "missing") return <p className="muted">이 단계에는 파일이 없습니다.</p>;
  return <><small>{value.mode} · {value.oid?.slice(0, 10) ?? "작업 파일"} · {value.bytes.toLocaleString()} B</small>{value.image ? <img src={value.image} alt="충돌 이미지 버전" /> : value.text !== null ? <pre>{value.text || "(빈 파일)"}</pre> : <p>{value.kind === "large" ? "미리보기 크기 제한" : value.kind === "gitlink" ? "서브모듈 커밋" : value.kind === "directory" ? "폴더" : "바이너리 또는 UTF-8 이외의 파일"}</p>}{value.kind === "symlink" ? <small>링크 대상 · 링크를 따라가지 않습니다.</small> : null}</>;
}
export function ScmConflictReview({ api, status, path, busy, submit, onError, onTerminal }: { api: Api; status: ScmStatus; path: string; busy: boolean; submit: (resolution: ScmResolution, statusRevision: string) => Promise<void>; onError: (error: string) => void; onTerminal: () => void }) {
  const [view, setView] = useState<ScmConflict | null>(null), [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(() => { try { const value = JSON.parse(localStorage.getItem(conflictDraftKey(status.workspaceId, path)) ?? "null") as Draft | null; return value && typeof value.revision === "string" && typeof value.content === "string" ? value : null; } catch { return null; } });
  const [choice, setChoice] = useState<ScmResolution["choice"]>(draft ? "edited" : "working"), [allowMarkers, setAllowMarkers] = useState(false), [storageError, setStorageError] = useState(false);
  useEffect(() => {
    let canceled = false; setLoading(true);
    void api.scmConflict(status.workspaceId, path, status.revision).then((next) => { if (!canceled) { setView(next); setAllowMarkers(false); } }).catch((error) => { if (!canceled) onError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [api, status.workspaceId, status.revision, path, onError]);
  useEffect(() => {
    if (!draft) return;
    try { localStorage.setItem(conflictDraftKey(status.workspaceId, path), JSON.stringify(draft)); setStorageError(false); } catch { setStorageError(true); }
  }, [draft, status.workspaceId, path]);
  if (!view) return <p className="scm-placeholder">3방향 충돌 내용을 불러오는 중…</p>;
  const rebase = view.operation === "rebase", staleDraft = draft !== null && draft.revision !== view.revision;
  const content = draft?.content ?? view.working.text ?? "", selected = choice === "ours" || choice === "theirs" ? view[choice] : view.working;
  const markers = choice !== "delete" && hasMarkers(choice === "edited" ? content : selected.text ?? "", view.markerSize);
  const unsupported = [view.ours, view.theirs].some((value) => value.kind === "gitlink") || view.working.kind === "directory";
  const invalid = loading || busy || unsupported || (choice === "edited" && staleDraft) || ((choice === "ours" || choice === "theirs") && (selected.kind === "missing" || selected.bytes > 16 * 1024 * 1024));
  const send = (stage: boolean) => submit({ path, expectedRevision: view.revision, choice, stage, ...(choice === "edited" ? { content } : {}), ...(allowMarkers ? { allowMarkers: true } : {}) }, view.statusRevision);
  const titles = { base: "기준본 · 1", ours: rebase ? "재배치 대상 · ours · 2" : "현재 쪽 · ours · 2", theirs: rebase ? "다시 적용할 커밋 · theirs · 3" : "가져온 쪽 · theirs · 3" };
  return <div className="scm-conflict-review" aria-label="3방향 충돌 검토">
    <header className="scm-diff-header"><strong>{path}</strong><span>3방향 충돌 검토</span></header>
    {rebase ? <p className="scm-warning">재배치 중입니다. ours는 대상 브랜치와 이미 적용한 커밋, theirs는 지금 다시 적용할 커밋입니다.</p> : null}
    <div className="scm-conflict-versions">{(["base", "ours", "theirs"] as const).map((side) => <section key={side} className={choice === side ? "selected" : ""}><h3>{titles[side]}</h3><Version value={view[side]} />{side !== "base" ? <button className={`button small scm-use-${side}`} disabled={busy || view[side].kind === "missing" || unsupported} onClick={() => { setChoice(side); setAllowMarkers(false); }}>이 파일 선택</button> : null}</section>)}</div>
    <section className="scm-resolution">
      <label>해결 방법 <select className="scm-resolution-choice" value={choice} disabled={busy} onChange={(event) => { const next = event.target.value as ScmResolution["choice"]; setChoice(next); setAllowMarkers(false); if (next === "edited" && !draft) setDraft({ revision: view.revision, content }); }}>
        <option value="working">현재 작업 파일 유지</option><option value="edited" disabled={!["text", "missing"].includes(view.working.kind)}>텍스트 편집 결과</option><option value="ours" disabled={view.ours.kind === "missing"}>{titles.ours}</option><option value="theirs" disabled={view.theirs.kind === "missing"}>{titles.theirs}</option><option value="delete">파일 삭제</option>
      </select></label>
      {choice === "edited" || choice === "working" && view.working.kind === "text" ? <><label htmlFor="scm-conflict-result">작업 파일 · 해결 결과</label><textarea id="scm-conflict-result" spellCheck={false} value={choice === "edited" ? content : view.working.text ?? ""} disabled={busy} onChange={(event) => { setChoice("edited"); setAllowMarkers(false); setDraft({ revision: draft?.revision ?? view.revision, content: event.target.value }); }} /><small>UTF-8 텍스트 2 MiB 이내. 초안은 이 앱에 보관하며, 저장 버튼을 눌러야 파일에 반영됩니다.</small></> : choice === "delete" ? <p className="scm-warning">현재 파일을 삭제합니다. 변경 전 파일은 로컬 복구 폴더에 보관합니다.</p> : <div className="scm-selected-version"><Version value={selected} /></div>}
      {storageError ? <p className="scm-error">앱 저장 공간이 부족해 초안을 보관하지 못했습니다. 닫기 전에 내용을 복사하거나 파일에 저장하세요.</p> : null}
      {staleDraft ? <div className="scm-warning">초안을 만든 뒤 파일 또는 Git 상태가 바뀌었습니다. 위의 최신 버전과 초안을 비교하세요. <button className="button small scm-adopt-draft" disabled={busy || loading} onClick={() => setDraft({ revision: view.revision, content })}>최신 상태를 검토하고 이 초안 사용</button></div> : null}
      {markers ? <label className="scm-marker-confirm"><input type="checkbox" checked={allowMarkers} onChange={(event) => setAllowMarkers(event.target.checked)} />충돌 표식처럼 보이는 줄을 의도한 파일 내용으로 유지합니다.</label> : null}
      <div className="scm-resolution-actions"><button className="button scm-save-resolution" disabled={invalid || choice === "working"} onClick={() => void send(false)}>파일에 저장</button><button className="button primary scm-stage-resolution" disabled={invalid || markers && !allowMarkers} onClick={() => void send(true)}>해결 완료 · 스테이징</button><button className="text-button" onClick={onTerminal}>작업공간 터미널</button></div>
      {unsupported ? <p className="scm-warning">서브모듈·폴더 충돌은 터미널에서 해결한 뒤 새로고침하세요.</p> : null}
    </section>
  </div>;
}
