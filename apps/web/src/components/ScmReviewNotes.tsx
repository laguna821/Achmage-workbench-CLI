import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ScmReviewBatch, ScmReviewBatchRequest, ScmReviewCreate, ScmReviewList, ScmReviewNote, ScmReviewPlacement, ScmReviewSelection, ScmReviewSnapshot, Workspace } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../api.ts";

type View = { path: string; snapshot: ScmReviewSnapshot };
type Draft = { path: string; snapshotId: string; selection: ScmReviewSelection | null; body: string; note?: ScmReviewNote };
type Context = { view: View | null; setView: (view: View | null) => void; begin: (view: View, selection: ScmReviewSelection | null) => void; data: ScmReviewList | null; show: () => void };
const ReviewContext = createContext<Context | null>(null);
export const useScmReviews = () => useContext(ReviewContext);
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const placementLabels: Record<ScmReviewPlacement["kind"], string> = { same: "원문 위치 확인됨", moved: "원문 위치 이동", changed: "원문이 바뀌거나 사라짐", ambiguous: "여러 위치 · 확인 필요", unavailable: "현재 위치 확인 전", "other-file": "다른 파일", "other-scope": "다른 비교 기준", file: "파일 의견" };
const batchLabels: Record<ScmReviewBatch["phase"], string> = { sending: "전달 중", queued: "대기 목록에 등록", accepted: "대화에 접수", failed: "전달 실패", uncertain: "전달 확인 필요", changed: "대기 요청 변경됨" };

export function ScmReviewsProvider({ api, workspace, children }: { api: Api; workspace: Workspace; children: ReactNode }) {
  const [view, setView] = useState<View | null>(null), [data, setData] = useState<ScmReviewList | null>(null), [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [target, setTarget] = useState(""), [resolved, setResolved] = useState(false);
  const [onlyFile, setOnlyFile] = useState(false), [retryCreate, setRetryCreate] = useState<ScmReviewCreate | null>(null), [retryBatch, setRetryBatch] = useState<ScmReviewBatchRequest | null>(null);
  const epoch = useRef(0), editor = useRef<HTMLTextAreaElement>(null);
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    try { const value = await api.scmReviews(workspace.id, view?.snapshot.id); if (current === epoch.current) setData(value); }
    catch (reason) { if (current === epoch.current) setError(messageOf(reason)); }
  }, [api, workspace.id, view?.snapshot.id]);
  useEffect(() => { void refresh(); return () => { epoch.current++; }; }, [refresh]);
  useEffect(() => { if (!open) return; const timer = setInterval(() => void refresh(), 1500); return () => clearInterval(timer); }, [open, refresh]);
  useEffect(() => { if (draft) { editor.current?.focus(); editor.current?.scrollIntoView({ block: "nearest" }); } }, [draft?.path, draft?.snapshotId, draft?.note?.id]);
  const begin = (next: View, selection: ScmReviewSelection | null) => {
    if (busy || retryCreate) { setOpen(true); return; }
    setOpen(true); setError(""); setDraft((previous) => ({ path: next.path, snapshotId: next.snapshot.id, selection, body: previous?.note ? "" : previous?.body ?? "" }));
  };
  const save = async () => {
    if (!draft || busy || !draft.body.trim()) return;
    setBusy(true); setError("");
    try {
      if (draft.note) await api.editScmReview(workspace.id, draft.note.id, { version: draft.note.version, body: draft.body });
      else {
        const request = retryCreate ?? { requestId: crypto.randomUUID(), snapshotId: draft.snapshotId, selection: draft.selection, body: draft.body };
        setRetryCreate(request); await api.createScmReview(workspace.id, request);
      }
      setRetryCreate(null); setDraft(null); await refresh();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status < 500) setRetryCreate(null);
      setError(messageOf(reason)); await refresh();
    } finally { setBusy(false); }
  };
  const mutate = async (note: ScmReviewNote, patch: { resolved?: boolean; deleted?: boolean }) => {
    setBusy(true); setError("");
    try { await api.editScmReview(workspace.id, note.id, { version: note.version, ...patch }); await refresh(); }
    catch (reason) { setError(messageOf(reason)); await refresh(); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (busy || !data) return;
    const request = retryBatch ?? { requestId: crypto.randomUUID(), sessionId: target, notes: data.notes.filter((n) => selected.includes(n.id) && !n.resolved).map(({ id, version }) => ({ id, version })) };
    setRetryBatch(request); setBusy(true); setError("");
    try { await api.sendScmReviews(workspace.id, request); setRetryBatch(null); setSelected([]); await refresh(); }
    catch (reason) { if (reason instanceof ApiRequestError && reason.status < 500) setRetryBatch(null); setError(messageOf(reason)); await refresh(); }
    finally { setBusy(false); }
  };
  const context: Context = { view, setView, begin, data, show: () => setOpen(true) };
  const shown = (data?.notes ?? []).filter((note) => (resolved || !note.resolved) && (!onlyFile || !["other-file", "unavailable"].includes(data?.placements[note.id]?.kind ?? "unavailable")));
  const count = data?.notes.filter((note) => !note.resolved).length ?? 0;
  return <ReviewContext.Provider value={context}>{children}
    <section className={`scm-notes${open ? " open" : ""}`} aria-label="Git 검토 의견">
      <header><button className="text-button scm-notes-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>검토 의견 · 미해결 {count}개 {open ? "접기" : "열기"}</button><small>의견과 검토 원문은 이 컴퓨터에 저장됩니다.</small>{view ? <button className="button small scm-file-note" disabled={busy || !!retryCreate} onClick={() => begin(view, null)}>파일 의견 추가</button> : null}</header>
      {open ? <div className="scm-notes-content">
        {error ? <p className="scm-error" role="alert">{error}</p> : null}
        {draft ? <form className="scm-note-editor" onSubmit={(event) => { event.preventDefault(); void save(); }} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy && !retryCreate) setDraft(null); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
        }}><strong>{draft.note ? "의견 수정" : "새 의견"} · {draft.path}</strong>
          {draft.selection ? <div className="scm-note-range"><span>{draft.selection.side === "before" ? "이전" : "이후"} 원문</span><label>시작 행<input type="number" className="scm-note-start" min={1} disabled={!!draft.note || !!retryCreate || busy} value={draft.selection.start} onChange={(e) => setDraft({ ...draft, selection: { ...draft.selection!, start: Number(e.target.value) } })} /></label><label>끝 행<input type="number" className="scm-note-end" min={draft.selection.start} disabled={!!draft.note || !!retryCreate || busy} value={draft.selection.end} onChange={(e) => setDraft({ ...draft, selection: { ...draft.selection!, end: Number(e.target.value) } })} /></label><small>표시된 연속 행 · 최대 100행</small></div> : <small>파일 전체에 대한 의견</small>}
          <textarea ref={editor} className="scm-note-body" aria-label="검토 의견 내용" maxLength={16384} readOnly={busy || !!retryCreate} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} placeholder="검토 의견 · Markdown 사용 가능" />
          {draft.note && data?.notes.find((n) => n.id === draft.note!.id)?.version !== draft.note.version ? <button type="button" className="button small scm-note-adopt" onClick={() => { const latest = data?.notes.find((n) => n.id === draft.note!.id); if (latest) setDraft({ ...draft, note: latest }); }}>아래 최신 의견을 확인했음 · 현재 입력으로 수정</button> : null}
          {retryCreate ? <small>저장 응답을 확인 중입니다. 재시도는 같은 요청을 확인하므로 중복 의견을 만들지 않습니다.</small> : null}
          <div><button className="button primary scm-note-save" disabled={busy || !draft.body.trim()}>{retryCreate ? "저장 결과 다시 확인" : "의견 저장"}</button><button type="button" className="button scm-note-cancel" disabled={busy || !!retryCreate} onClick={() => setDraft(null)}>취소</button><small>Ctrl/Cmd+Enter 저장 · Esc 취소</small></div>
        </form> : null}
        <div className="scm-notes-filters"><label><input className="scm-notes-resolved" type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} />해결한 의견 포함</label><label><input type="checkbox" checked={onlyFile} onChange={(e) => setOnlyFile(e.target.checked)} />열어 둔 파일만</label><button className="text-button" onClick={() => void refresh()}>의견 새로고침</button><button className="text-button" disabled={busy || !!retryBatch} onClick={() => setSelected(shown.filter((n) => !n.resolved).map((n) => n.id))}>보이는 미해결 의견 선택</button></div>
        <div className="scm-note-list">{shown.map((note) => {
          const placement = data?.placements[note.id], sent = data?.batches.find((b) => b.notes.some((n) => n.id === note.id && n.version === note.version));
          return <article key={note.id} className={`scm-note${note.resolved ? " resolved" : ""}`} data-note-id={note.id}><header><label><input className="scm-note-select" type="checkbox" disabled={note.resolved || busy || !!retryBatch} checked={selected.includes(note.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, note.id] : ids.filter((id) => id !== note.id))} /><strong>{note.anchor.path}</strong></label><small>v{note.version} · {note.resolved ? "해결됨" : "미해결"}</small></header>
            <p className="scm-note-location">{note.anchor.selection ? `${note.anchor.selection.side === "before" ? "이전" : "이후"} ${note.anchor.selection.start}–${note.anchor.selection.end}행 · ` : ""}{placementLabels[placement?.kind ?? "unavailable"]}{placement?.start ? ` · 현재 ${placement.start}–${placement.end}행` : ""}</p>
            <div className="markdown scm-note-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt ?? "이미지"}</span> }}>{note.body}</Markdown></div>
            <details className="scm-note-original"><summary>검토 당시 원문과 기준</summary><pre>{note.anchor.quote.length ? note.anchor.quote.join("\n") : "파일 의견"}</pre><code>{JSON.stringify(note.anchor.source)}</code><small>원문 해시 {note.anchor.contentHash ?? "파일 의견"} · 비교 {note.anchor.diffRevision}</small></details>
            {sent ? <small className="scm-note-delivery">이 버전: {batchLabels[sent.phase]} · {sent.target.provider} / {sent.target.purpose}</small> : <small className="scm-note-delivery">이 버전은 아직 전달 기록이 없습니다.</small>}
            <div className="scm-note-actions"><button className="text-button scm-note-edit" disabled={busy || !!retryCreate} onClick={() => { setError(""); setDraft({ path: note.anchor.path, snapshotId: "", selection: note.anchor.selection, body: note.body, note }); }}>수정</button><button className="text-button scm-note-resolve" disabled={busy} onClick={() => void mutate(note, { resolved: !note.resolved })}>{note.resolved ? "다시 검토" : "해결로 표시"}</button><details><summary>삭제</summary><button className="text-button scm-note-delete" disabled={busy} onClick={() => void mutate(note, { deleted: true })}>이 의견 삭제 · 전달 기록은 보존</button></details></div>
          </article>;
        })}{!shown.length ? <p className="muted">아직 표시할 의견이 없습니다. 비교 행의 + 또는 파일 의견 추가를 사용하세요.</p> : null}</div>
        <section className="scm-note-send"><strong>같은 작업공간의 대화에 보내기</strong><small>선택 {selected.filter((id) => data?.notes.some((n) => n.id === id && !n.resolved)).length}개 · 바쁜 대화는 대기 목록에 넣습니다.</small>
          <fieldset className="scm-note-targets"><legend>받을 대화</legend>{data?.targets.map((session) => <label key={session.id}><input className="scm-note-target" type="radio" name="scm-note-target" value={session.id} checked={target === session.id} disabled={busy || !!retryBatch} onChange={() => setTarget(session.id)} />{session.provider} · {session.purpose} · {session.status === "idle" ? "대기" : session.status === "error" ? "오류 확인 필요" : "실행 중"}</label>)}</fieldset>
          <div>{(["codex", "claude"] as const).map((provider) => <button className={`button small scm-review-new-${provider}`} key={provider} disabled={busy || !!retryBatch || !!workspace.archivedAt || !!workspace.removedAt} onClick={async () => { setBusy(true); setError(""); try { const session = await api.createSession(workspace.workId, provider, { workspaceId: workspace.id, purpose: "Git 검토 의견" }); setTarget(session.id); await refresh(); } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); } }}>새 {provider} 대화</button>)}</div>
          <button className="button primary scm-note-send-button" disabled={busy || (!retryBatch && (!data?.targets.some((s) => s.id === target) || !selected.some((id) => data?.notes.some((n) => n.id === id && !n.resolved))))} onClick={() => void send()}>{retryBatch ? "같은 전달 요청 결과 확인" : "선택 의견 묶어 보내기"}</button>
          {data?.batches.map((batch) => <details className="scm-note-batch" key={batch.id} data-phase={batch.phase}><summary>{batchLabels[batch.phase]} · {batch.notes.length}개 · {batch.target.provider} / {batch.target.purpose} · {new Date(batch.createdAt).toLocaleString()}</summary><p>{batch.detail}</p><pre>{batch.text}</pre></details>)}
        </section>
      </div> : null}
    </section>
  </ReviewContext.Provider>;
}
