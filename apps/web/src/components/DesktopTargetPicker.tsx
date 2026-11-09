import { useEffect, useRef, useState } from "react";
import type { DesktopObservation, DesktopState, DesktopWindow } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { FeatureDialog, featureError, featureTime } from "./FeatureDialog.tsx";

export function DesktopTargetPicker({ api, sessions, onClose }: { api: Api; sessions: { id: string; label: string }[]; onClose(): void }) {
  const [state, setState] = useState<DesktopState | null>(null), [windows, setWindows] = useState<DesktopWindow[]>([]);
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? ""), [windowId, setWindowId] = useState(""), [headed, setHeaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [observation, setObservation] = useState<DesktopObservation | null>(null);
  const live = useRef(true);
  const refresh = async () => { const next = await api.request<DesktopState>("GET", "/api/desktop"); if (live.current) setState(next); return next; };
  useEffect(() => { live.current = true; void refresh().catch(error => { if (live.current) setError(featureError(error)); }); return () => { live.current = false; }; }, [api]);
  const perform = async (run: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await run(); await refresh(); } catch (error) { if (live.current) setError(featureError(error)); }
    finally { if (live.current) setBusy(false); }
  };
  const loadWindows = async () => { const list = await api.request<DesktopWindow[]>("GET", "/api/desktop/windows"); if (live.current) setWindows(list); };
  const target = state?.targets.find(row => row.sessionId === sessionId);
  return <FeatureDialog title="외부 앱" description="작업할 앱 창을 세션에 연결한 뒤 채팅에서 요청하세요. 앱 창별로 작업 기록을 남깁니다." onClose={onClose}>
    {error ? <p role="alert" className="notice notice-error compact">{error}</p> : null}
    {!state ? <p role="status">외부 앱 도구 확인 중…</p> : <>
      <p>agent-desktop {state.version} · {state.installed ? "설치됨" : state.installing ? "설치 중" : "설치되지 않음"}</p>
      {!state.supported ? <p>이 운영체제·CPU용 공식 실행 파일이 아직 없습니다.</p> : !state.installed ? <button type="button" className="button primary" disabled={busy || state.installing} onClick={() => void perform(async () => { await api.request("POST", "/api/desktop/install"); await loadWindows(); })}>공식 도구 설치하고 앱 목록 보기</button> : <>
        <div className="feature-actions"><button type="button" className="button small" disabled={busy} onClick={() => void perform(loadWindows)}>열린 앱 창 새로고침</button><button type="button" className="button small" disabled={busy} onClick={() => void perform(() => api.request("POST", "/api/desktop/status"))}>접근 권한 확인</button><button type="button" className="button small" disabled={busy} onClick={() => void perform(() => api.request("POST", "/api/desktop/permissions"))}>운영체제 권한 요청</button></div>
        <form className="feature-form" onSubmit={event => { event.preventDefault(); void perform(async () => { await api.request("PUT", `/api/desktop/sessions/${encodeURIComponent(sessionId)}`, { windowId, headed }); if (live.current) setObservation(null); }); }}>
          <fieldset disabled={busy}><label>작업할 채팅 세션<select required value={sessionId} onChange={event => { setSessionId(event.target.value); setObservation(null); }}><option value="">세션 선택</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.label}</option>)}</select></label>
          <label>앱 창<select required value={windowId} onChange={event => setWindowId(event.target.value)}><option value="">창 목록을 불러와 선택하세요</option>{windows.map(window => <option key={`${window.id}:${window.pid}`} value={window.id}>{window.app_name} · {window.title || "제목 없음"}</option>)}</select></label>
          <label><input type="checkbox" checked={headed} onChange={event => setHeaded(event.target.checked)} />화면 앞으로 가져오기와 키보드·마우스 사용 허용</label><p className="sheet-hint">기본은 앱이 제공하는 접근성 기능으로 조작합니다. 화면 조작을 켜면 작업 중 포인터나 초점이 바뀔 수 있습니다.</p>
          <button type="submit" className="button primary" disabled={!sessionId || !windowId}>이 세션에 연결</button></fieldset>
        </form>
        {!sessions.length ? <p>프로젝트에서 채팅 세션을 먼저 만드세요.</p> : null}
        {target ? <section className="feature-section"><h3>{target.window.app_name} · {target.window.title}</h3><p>{target.headed ? "키보드·마우스 사용 허용" : "접근성 조작"} · 연결된 세션의 채팅에서 작업을 요청할 수 있습니다.</p>{target.needsReconcile ? <p role="status">이전 동작 결과가 불명확합니다. 아래 기록에서 현재 화면을 다시 확인하세요.</p> : null}
          <div className="feature-actions"><button className="button small" disabled={busy} onClick={() => void perform(async () => { const view = await api.request<DesktopObservation>("POST", `/api/desktop/sessions/${encodeURIComponent(sessionId)}/snapshot`); if (live.current) setObservation(view); })}>앱 화면 읽기</button><button className="button small" disabled={busy} onClick={() => void perform(() => api.request("POST", `/api/desktop/sessions/${encodeURIComponent(sessionId)}/screenshot`))}>화면 캡처를 채팅에 남기기</button><button className="button small" disabled={busy} onClick={() => void perform(async () => { await api.request("DELETE", `/api/desktop/sessions/${encodeURIComponent(sessionId)}`); if (live.current) setObservation(null); })}>연결 해제</button></div>
        </section> : null}
        {state.targets.length ? <button type="button" className="button danger" onClick={() => { setError(null); void api.request<DesktopState>("POST", "/api/desktop/take-over").then(next => { if (live.current) { setState(next); setObservation(null); } }).catch(error => { if (live.current) setError(featureError(error)); }); }}>내가 조작하기 · 모든 앱 작업 중단</button> : null}
      </>}
      {observation ? <section><h3>읽은 화면</h3><p>{observation.complete ? "화면 읽기 완료" : "일부만 읽었습니다"}{observation.identityUnproven ? " · 창 식별을 확인하지 못해 조작할 수 없습니다" : ""}</p><pre className="feature-output">{JSON.stringify(observation.data, null, 2)}</pre></section> : null}
      {state.permissionStatus ? <details><summary>운영체제 접근 권한 안내</summary><pre className="feature-output">{JSON.stringify(state.permissionStatus.ok ? state.permissionStatus.data : state.permissionStatus.error, null, 2)}</pre></details> : null}
      <section className="feature-section"><h3>앱 작업 기록</h3><p className="sheet-hint">동작 전달 완료와 문서 저장 완료는 다릅니다. 결과가 불명확한 동작은 자동으로 반복하지 않습니다.</p>{state.receipts.filter(receipt => !sessionId || receipt.sessionId === sessionId).map(receipt => <article key={receipt.id}><strong>{receipt.action} · {{ running: "실행 중", completed: "동작 전달됨", failed: "실패", outcome_unknown: "결과 확인 필요" }[receipt.state]}</strong><p>{featureTime(receipt.startedAt)}{receipt.error ? ` · ${receipt.error}` : ""}</p>{receipt.state === "outcome_unknown" && target ? <button type="button" className="button small" disabled={busy} onClick={() => void perform(async () => { const result = await api.request<{ observation: DesktopObservation }>("POST", `/api/desktop/sessions/${encodeURIComponent(sessionId)}/reconcile`, { commandId: receipt.id }); if (live.current) setObservation(result.observation); })}>현재 화면 다시 확인</button> : null}</article>)}</section>
    </>}
  </FeatureDialog>;
}
