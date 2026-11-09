import { useState } from "react";
import type { HubRelationshipConnect, HubRelationshipSnapshot, HubSnapshot } from "../../../../packages/contracts/src/event-hub.ts";
import type { Api } from "../api.ts";
import { featureTime } from "./FeatureDialog.tsx";

const labels: Record<HubRelationshipSnapshot["state"], string> = {
  disabled: "연결 꺼짐", credential_locked: "보안 저장소 잠김", not_connected: "등록되지 않음", connecting: "연결 중",
  connected: "연결됨", reconnecting: "재연결 중", disconnecting: "관계 해제 중", revoked: "Hub에서 철회됨",
};
const localDate = (value: number) => new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
type Perform = (action: () => Promise<unknown>, message: string) => Promise<void>;

/** Original external Paseo Hub connection is an explicit local choice. Nothing
 * in rendering this form enrolls a daemon or sends account data. */
export function PaseoHubConnection({ api, snapshot, busy, perform }: { api: Api; snapshot: HubSnapshot; busy: boolean; perform: Perform }) {
  const connection = snapshot.relationship;
  const [url, setUrl] = useState(""), [token, setToken] = useState(""), [sessionId, setSessionId] = useState("");
  const [profileId, setProfileId] = useState(""), [interval, setIntervalValue] = useState(60);
  const [expiry, setExpiry] = useState(() => localDate(Date.now() + 7 * 86400_000));
  const [consent, setConsent] = useState(false), [execute, setExecute] = useState(false);
  const target = snapshot.targets.find(value => value.sessionId === sessionId);
  const selectedProfile = snapshot.profiles.find(value => value.id === (profileId || target?.profileId));
  if (!connection) return null;
  const registered = !!connection.daemonId && connection.state !== "revoked";
  return <section className="feature-section" aria-labelledby="paseo-hub-title">
    <h3 id="paseo-hub-title">Paseo Hub에 이 PC 연결</h3>
    <p className="sheet-hint">Paseo Hub 서비스에서 발급한 등록 토큰이 필요합니다. 아래의 GitHub·Slack·Discord 서명 수신과는 별도 연결입니다. Hub 서버는 Workbench에 포함되지 않습니다.</p>
    <p role="status"><strong>{labels[connection.state]}</strong>{connection.hubOrigin ? <> · {connection.hubOrigin}</> : null}</p>
    {connection.lastError ? <p className="notice notice-error compact" role="alert">{connection.lastError}</p> : null}
    <dl className="feature-details">
      <dt>자격증명 보관</dt><dd>운영체제 보안 저장소로 봉인 · 평문 대체 저장 없음</dd>
      <dt>실행 권한</dt><dd>{connection.permissions.includes("hub.execute") ? "선택한 작업공간에서 요청 실행과 소유 결과 전송" : "실행 허용 안 함"}</dd>
      {connection.approvedSettings ? <><dt>승인한 실행 설정</dt><dd>{connection.approvedSettings.provider} · {connection.approvedSettings.model ?? "기존 기본 모델"} · {connection.approvedSettings.profileName ?? "대화 설정"} · 접근 {connection.approvedSettings.access}</dd></> : null}
      {connection.selection ? <><dt>승인한 대상</dt><dd>{snapshot.targets.find(value => value.sessionId === connection.selection?.sessionId)?.label ?? connection.selection.sessionId} · {connection.selection.workspaceId}</dd>
        <dt>권한 만료</dt><dd>{featureTime(connection.selection.expiresAt)} · 최소 {connection.selection.minIntervalSeconds}초 간격</dd></> : null}
      {connection.connectedAt ? <><dt>최근 연결</dt><dd>{featureTime(Date.parse(connection.connectedAt))}</dd></> : null}
    </dl>
    {registered ? <div className="feature-actions">
      <button type="button" className="button small" disabled={busy} onClick={() => void perform(() => api.request("POST", "/api/hub/relationship/enabled", { enabled: !connection.enabled }), connection.enabled ? "Hub 연결을 일시 정지했습니다. 이미 접수한 작업 기록은 남습니다." : "저장한 Hub 관계를 다시 연결합니다.")}>{connection.enabled ? "연결 일시 정지" : "연결 다시 켜기"}</button>
      <button type="button" className="button small" disabled={busy || !connection.enabled} onClick={() => void perform(() => api.request("POST", "/api/hub/relationship/permissions", { allowExecution: !connection.permissions.includes("hub.execute") }), connection.permissions.includes("hub.execute") ? "Hub 실행 권한을 철회했습니다." : "승인한 대상에서 Hub 실행과 결과 전송을 허용했습니다.")}>{connection.permissions.includes("hub.execute") ? "실행 권한 철회" : "실행과 결과 전송 허용"}</button>
      <button type="button" className="button small" disabled={busy} onClick={() => void perform(() => api.request("POST", "/api/hub/relationship/disconnect", { force: false }), "Hub에 관계 해제를 요청하고 로컬 자격증명을 제거했습니다. 경고가 있으면 확인해 주세요.")}>관계 해제</button>
      <button type="button" className="button small" disabled={busy} onClick={() => void perform(() => api.request("POST", "/api/hub/relationship/disconnect", { force: true }), "로컬 관계를 제거했습니다. Hub의 등록은 서비스에서 별도로 확인해 주세요.")}>외부 요청 없이 로컬 해제</button>
    </div> : null}
    {!registered ? <form className="feature-form" onSubmit={event => {
      event.preventDefault(); if (!target || !consent) return;
      const input: HubRelationshipConnect = { hubUrl: url, token, confirmExternalConnection: true, allowExecution: execute,
        selection: { sessionId: target.sessionId, workspaceId: target.workspaceId, profileId: profileId || null,
          minIntervalSeconds: interval, expiresAt: expiry ? new Date(expiry).getTime() : null } };
      void perform(async () => { try { return await api.request("POST", "/api/hub/relationship/connect", input); } finally { setToken(""); setConsent(false); } }, "Hub 등록을 요청했습니다. 연결 상태와 실행 권한을 확인해 주세요.");
    }}>
      <fieldset disabled={busy}>
        <label>Hub 서비스 주소<input type="url" required autoComplete="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="Hub에서 안내한 HTTPS 주소" /></label>
        <label>일회 등록 토큰<input type="password" required autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} /></label>
        <label>작업공간과 대화 템플릿<select required value={sessionId} onChange={event => setSessionId(event.target.value)}><option value="">선택</option>{snapshot.targets.filter(value => value.hubTemplate !== false).map(value => <option key={value.sessionId} value={value.sessionId}>{value.label} · {value.workspaceId}</option>)}</select></label>
        <label>실행 역할<select value={profileId} onChange={event => setProfileId(event.target.value)}><option value="">선택한 대화 설정</option>{snapshot.profiles.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
        {target ? <p className="sheet-hint">승인할 설정 · {target.provider} · {target.model ?? selectedProfile?.model ?? "기존 기본 모델"} · 추론 {target.effort ?? selectedProfile?.effort ?? "기존 기본값"} · 접근 {target.access ?? selectedProfile?.access ?? target.fallbackAccess}</p> : null}
        <label>최소 요청 간격(초)<input type="number" min={1} max={86400} required value={interval} onChange={event => setIntervalValue(Number(event.target.value))} /></label>
        <label>실행 권한 만료<input type="datetime-local" value={expiry} onChange={event => setExpiry(event.target.value)} /></label>
        <p className="sheet-hint">대상의 모델과 역할, 기존 접근 권한을 고정해 새 대화에서 실행합니다. 해당 설정에서 필요한 승인은 Workbench에서 처리합니다. Hub가 보내는 임의 환경변수, MCP 서버, 도구 권한 및 새 worktree 요청은 적용하지 않습니다.</p>
        <label className="feature-check"><input type="checkbox" checked={execute} onChange={event => setExecute(event.target.checked)} />선택한 작업공간에서 Hub 요청 실행과 해당 응답의 Hub 전송 허용</label>
        <label className="feature-check"><input type="checkbox" required checked={consent} onChange={event => setConsent(event.target.checked)} />입력한 외부 Hub에 이 PC를 등록하고 연결합니다</label>
        <button type="submit" className="button small primary" disabled={!consent || !target}>Hub 등록하고 연결</button>
      </fieldset>
    </form> : <p className="sheet-hint">작업공간·모델·역할을 바꾸려면 기존 관계를 해제한 뒤 새 토큰으로 다시 승인합니다. 연결 중단 뒤에는 원본 Paseo 재연결 정책을 사용하며, 결과가 불명확한 작업은 자동 재전송하지 않습니다.</p>}
    <details><summary>Hub 실행 기록 {connection.executions.length}개</summary><div className="feature-cards">{connection.executions.map(item => <article key={item.commandId}><strong>{item.executionId}</strong><p>{item.state} · {featureTime(item.createdAt)}</p>{item.detail ? <p>{item.detail}</p> : null}<small className="feature-mono">{item.sessionId ? "대화 " + item.sessionId : "대화 생성 미확인"} · {item.commandId}</small></article>)}</div></details>
  </section>;
}
