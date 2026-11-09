import { useEffect, useRef, useState } from "react";
import { HUB_STATUS_LABEL, type HubConnector, type HubConnectorInput, type HubDeliveryState, type HubSnapshot, type HubWorkflow, type HubWorkflowInput } from "../../../../packages/contracts/src/event-hub.ts";
import type { Api } from "../api.ts";
import { FeatureDialog, featureError, featureTime } from "./FeatureDialog.tsx";
import { PaseoHubConnection } from "./PaseoHubConnection.tsx";

const list = (value: string) => [...new Set(value.split(/[\n,]/).map(part => part.trim()).filter(Boolean))];
const localDate = (value: number | null) => value === null ? "" : new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const newConnector = (): HubConnectorInput => ({ name: "", kind: "github", enabled: false });
const newWorkflow = (hostId: string): HubWorkflowInput => ({ name: "", connectorId: "", enabled: false, allowedSources: [], eventTypes: [], hostId, workspaceId: "", sessionId: "", profileId: null, instructions: "", minIntervalSeconds: 60, expiresAt: Date.now() + 7 * 86400_000 });

/** Signed ingress and an explicitly enrolled outbound Hub relationship remain separate. */
export function EventHub({ api, onClose }: { api: Api; onClose(): void }) {
  const [state, setState] = useState<HubSnapshot | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [connector, setConnector] = useState<HubConnectorInput>(newConnector), [workflow, setWorkflow] = useState<HubWorkflowInput | null>(null);
  const [sourceText, setSourceText] = useState(""), [eventText, setEventText] = useState("");
  const live = useRef(true), pending = useRef(false);
  const refresh = async () => { const next = await api.request<HubSnapshot>("GET", "/api/hub"); if (live.current) { setState(next); setWorkflow(current => current ?? newWorkflow(next.hostId)); } return next; };
  useEffect(() => {
    live.current = true;
    if (!api.isRemote) { void refresh().catch(reason => { if (live.current) setError(featureError(reason)); }); }
    const timer = setInterval(() => { if (!api.isRemote && !pending.current) void refresh().catch(reason => { if (live.current) setError(featureError(reason)); }); }, 5000);
    return () => { live.current = false; clearInterval(timer); };
  }, [api]);
  const perform = async (action: () => Promise<unknown>, message: string) => {
    if (pending.current || api.isRemote) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); if (live.current) setNotice(message); }
    catch (reason) { if (live.current) setError(featureError(reason)); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  const editConnector = (value: HubConnector) => setConnector({ id: value.id, expectedRevision: value.revision, name: value.name, kind: value.kind, enabled: value.enabled, ...(value.publicKey ? { publicKey: value.publicKey } : {}) });
  const editWorkflow = (value: HubWorkflow) => { setWorkflow({ ...value, expectedRevision: value.revision }); setSourceText(value.allowedSources.join("\n")); setEventText(value.eventTypes.join("\n")); };
  const connectorKind = state?.connectors.find(item => item.id === workflow?.connectorId)?.kind ?? "github";
  const target = state?.targets.find(item => item.sessionId === workflow?.sessionId && item.workspaceId === workflow?.workspaceId);
  return <FeatureDialog title="이벤트 Hub" description="허용한 GitHub·Slack·Discord 이벤트를 지정한 작업에 전달합니다." onClose={onClose}>
    {api.isRemote ? <p>이벤트 연결과 자동 실행 설정은 호스트 PC에서 관리합니다.</p> : <>
      {error ? <p className="notice notice-error compact" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
      <div className="feature-actions"><button type="button" className="button small" disabled={busy} onClick={() => void perform(refresh, "목록을 새로 불러왔습니다.")}>새로고침</button><span>{state?.ingress.enabled ? "이벤트 수신 켜짐" : "이벤트 수신 꺼짐"}</span></div>
      {state?.ingress.url ? <p className="feature-mono">수신 주소 {state.ingress.url}</p> : null}{state?.ingress.message ? <p className="sheet-hint">{state.ingress.message}</p> : null}
      {!state ? <p role="status">Hub 불러오는 중…</p> : <>
        <PaseoHubConnection api={api} snapshot={state} busy={busy} perform={perform} />
        <section className="feature-section"><h3>이벤트 연결</h3><div className="feature-cards">{state.connectors.map(item => <article key={item.id}><strong>{item.name}</strong><p>{item.kind} · {item.enabled ? "켜짐" : "꺼짐"} · {item.credentialConfigured ? "서명 확인 설정됨" : "서명 확인 정보 필요"}</p><small>최근 수신 {featureTime(item.lastReceivedAt)}</small><div className="feature-actions"><button type="button" className="button small" disabled={busy} onClick={() => editConnector(item)}>설정 편집</button></div></article>)}{!state.connectors.length ? <p>등록한 이벤트 연결이 없습니다.</p> : null}</div>
          <form className="feature-form" onSubmit={event => { event.preventDefault(); void perform(async () => { const result = await api.request<HubConnector>("POST", "/api/hub/connectors", connector); if (live.current) editConnector(result); }, "이벤트 연결을 저장했습니다."); }}>
            <h4>{connector.id ? "연결 편집" : "새 연결"}</h4>{connector.kind === "discord" ? <p className="sheet-hint">Discord 공식 Webhook Events를 받습니다. 일반 서버 메시지 전체 수신은 지원하지 않습니다.</p> : null}<fieldset disabled={busy}>
              <label>연결 이름<input required value={connector.name} onChange={event => setConnector({ ...connector, name: event.target.value })} /></label>
              <label>서비스<select disabled={!!connector.id} value={connector.kind} onChange={event => setConnector({ ...newConnector(), name: connector.name, kind: event.target.value as HubConnectorInput["kind"] })}><option value="github">GitHub</option><option value="slack">Slack</option><option value="discord">Discord</option></select></label>
              {connector.kind === "discord" ? <label>Discord 공개 키<input required value={connector.publicKey ?? ""} onChange={event => setConnector({ ...connector, publicKey: event.target.value })} autoComplete="off" /></label> : <label>{connector.kind === "slack" ? "Slack Signing Secret" : "GitHub Webhook Secret"}<input type="password" autoComplete="new-password" required={!connector.id} value={connector.secret ?? ""} placeholder={connector.id ? "변경할 때만 입력" : "서비스에서 설정한 서명 비밀값"} onChange={event => setConnector({ ...connector, secret: event.target.value || undefined })} /></label>}
              <label className="feature-check"><input type="checkbox" checked={connector.enabled} onChange={event => setConnector({ ...connector, enabled: event.target.checked })} />이 연결의 이벤트 수신</label><div className="feature-actions"><button className="button small primary" type="submit">연결 저장</button><button className="button small" type="button" onClick={() => setConnector(newConnector())}>새 연결 작성</button></div>
            </fieldset>
          </form>
        </section>
        <section className="feature-section"><h3>자동 실행 규칙</h3><p className="sheet-hint">이벤트 본문은 외부 자료로 전달합니다. 게시·답장 기능은 없으며, 작업에 필요한 승인은 Workbench에서 확인합니다.</p>
          <div className="feature-cards">{state.workflows.map(item => <article key={item.id}><strong>{item.name}</strong><p>{item.enabled ? "사용 중" : "일시 정지"} · {item.allowedSources.join(", ")}</p><small>{item.eventTypes.join(", ")} · 최소 {item.minIntervalSeconds}초 간격 · 만료 {featureTime(item.expiresAt)}</small><div className="feature-actions"><button type="button" className="button small" disabled={busy} onClick={() => editWorkflow(item)}>규칙 편집</button><button type="button" className="button small" disabled={busy} onClick={() => void perform(() => api.request<HubWorkflow>("POST", `/api/hub/workflows/${encodeURIComponent(item.id)}/pause`, { expectedRevision: item.revision, paused: item.enabled }), item.enabled ? "규칙을 일시 정지했습니다." : "규칙을 다시 켰습니다.")}>{item.enabled ? "일시 정지" : "다시 켜기"}</button></div></article>)}{!state.workflows.length ? <p>등록한 자동 실행 규칙이 없습니다.</p> : null}</div>
          {workflow ? <form className="feature-form" onSubmit={event => { event.preventDefault(); if (!target) return; void perform(async () => { const result = await api.request<HubWorkflow>("POST", "/api/hub/workflows", { ...workflow, allowedSources: list(sourceText), eventTypes: list(eventText), hostId: state.hostId, sessionId: target.sessionId, workspaceId: target.workspaceId }); if (live.current) editWorkflow(result); }, "자동 실행 규칙을 저장했습니다."); }}>
            <h4>{workflow.id ? "규칙 편집" : "새 규칙"}</h4><fieldset disabled={busy}>
              <label>규칙 이름<input required value={workflow.name} onChange={event => setWorkflow({ ...workflow, name: event.target.value })} /></label>
              <label>이벤트 연결<select required value={workflow.connectorId} onChange={event => setWorkflow({ ...workflow, connectorId: event.target.value })}><option value="">연결 선택</option>{state.connectors.map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}</select></label>
              <label>허용할 출처 · {connectorKind === "github" ? "소유자/저장소" : connectorKind === "slack" ? "워크스페이스 ID/채널 ID" : "앱 ID/채널·로비·서버 ID (없으면 app)"}<textarea required rows={2} value={sourceText} onChange={event => setSourceText(event.target.value)} placeholder="한 줄에 하나씩 정확한 출처 입력" /></label>
              <label>허용할 이벤트 종류<textarea required rows={2} value={eventText} onChange={event => setEventText(event.target.value)} placeholder={connectorKind === "github" ? "issues" : connectorKind === "discord" ? "APPLICATION_AUTHORIZED" : "message"} /></label>
              <label>실행할 작업<select required value={target ? `${target.workspaceId}:${target.sessionId}` : ""} onChange={event => { const chosen = state.targets.find(item => `${item.workspaceId}:${item.sessionId}` === event.target.value); if (chosen) setWorkflow({ ...workflow, sessionId: chosen.sessionId, workspaceId: chosen.workspaceId }); }}><option value="">작업공간·세션 선택</option>{state.targets.map(item => <option key={`${item.workspaceId}:${item.sessionId}`} value={`${item.workspaceId}:${item.sessionId}`}>{item.label}</option>)}</select></label>
              <label>에이전트 설정<select value={workflow.profileId ?? ""} onChange={event => setWorkflow({ ...workflow, profileId: event.target.value || null })}><option value="">해당 세션의 설정</option>{state.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label>이벤트를 받았을 때 수행할 요청<textarea required rows={3} value={workflow.instructions} onChange={event => setWorkflow({ ...workflow, instructions: event.target.value })} /></label>
              <label>실행 사이 최소 간격 (초)<input type="number" min={1} max={86400} required value={workflow.minIntervalSeconds} onChange={event => setWorkflow({ ...workflow, minIntervalSeconds: Number(event.target.value) })} /></label>
              <label>사용 기한<input type="datetime-local" value={localDate(workflow.expiresAt)} onChange={event => setWorkflow({ ...workflow, expiresAt: event.target.value ? new Date(event.target.value).getTime() : null })} /></label>
              <label className="feature-check"><input type="checkbox" checked={workflow.enabled} onChange={event => setWorkflow({ ...workflow, enabled: event.target.checked })} />이 규칙으로 자동 실행 허용</label><p className="sheet-hint">대상 호스트 {state.hostId} · 기한을 비우면 만료 없이 사용합니다.</p>
              <div className="feature-actions"><button className="button small primary" type="submit" disabled={!target || !list(sourceText).length || !list(eventText).length}>규칙 저장</button><button className="button small" type="button" onClick={() => { setWorkflow(newWorkflow(state.hostId)); setSourceText(""); setEventText(""); }}>새 규칙 작성</button></div>
            </fieldset>
          </form> : null}
        </section>
        <section className="feature-section"><h3>수신·실행 기록</h3>{!state.deliveries.length ? <p>수신한 이벤트가 없습니다.</p> : <div className="feature-history">{state.deliveries.map(item => <article key={item.id}><strong>{HUB_STATUS_LABEL[item.state]} · {item.source}</strong><p>{item.eventType} · {featureTime(item.createdAt)}</p><small>{item.detail ?? ""}</small><details><summary>전달 정보</summary><p>전달 ID {item.deliveryId} · 규칙 판본 {item.workflowRevision}</p><p>호스트 {item.targetHostId} · 작업공간 {item.targetWorkspaceId} · 세션 {item.sessionId}</p><p className="feature-mono">내용 해시 {item.payloadHash}</p>{item.resultRef ? <p>결과 {item.resultRef}</p> : null}</details>{["accepted", "running", "waiting_input", "outcome_unknown"].includes(item.state) ? <button type="button" className="button small" disabled={busy} onClick={() => void perform(() => api.request<HubDeliveryState>("POST", `/api/hub/deliveries/${encodeURIComponent(item.id)}/reconcile`, {}), "기존 작업의 결과를 다시 확인했습니다.")}>기존 작업 결과 확인</button> : null}</article>)}</div>}</section>
      </>}
    </>}
  </FeatureDialog>;
}
