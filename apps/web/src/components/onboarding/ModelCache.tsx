import { useEffect, useRef, useState } from "react";
import type { VoiceStatus } from "../../../../../packages/contracts/src/voice.ts";
import type { Api } from "../../api.ts";

const bytes = (value: number | null) => value === null ? "확인 전" : `${(value / 1024 / 1024).toLocaleString("ko-KR", { maximumFractionDigits: 1 })} MB`;

/** Existing VoiceService owns downloads and settings. This does not enable speech or request a key. */
export function OnboardingModelCache({ api }: { api?: Api }) {
  const [open, setOpen] = useState(false), [status, setStatus] = useState<VoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const live = useRef(true);
  const owner = useRef(api); owner.current = api;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { setStatus(null); setError(null); }, [api]);
  const refresh = () => {
    if (!api) return;
    setError(null);
    void api.request<VoiceStatus>("GET", "/api/voice").then(value => { if (live.current && owner.current === api) setStatus(value); }, reason => { if (live.current && owner.current === api) setError(reason instanceof Error ? reason.message : String(reason)); });
  };
  useEffect(() => {
    if (!open) return;
    refresh();
    const downloading = status?.models.some(model => model.state === "downloading");
    if (!downloading) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [open, api, status?.models.some(model => model.state === "downloading")]);
  const change = async (id: string, action: "download" | "cancel") => {
    if (!api || busy) return;
    setBusy(true); setError(null);
    try {
      const value = await api.request<VoiceStatus>("POST", `/api/voice/models/${encodeURIComponent(id)}/${action}`, action === "download" ? { accepted: true } : {});
      if (live.current && owner.current === api) setStatus(value);
    } catch (reason) { if (live.current && owner.current === api) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (live.current && owner.current === api) setBusy(false); }
  };
  return <details className="onboarding-tool-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>음성 모델 캐시 · 선택 사항</summary>
    <p>모델 다운로드와 음성 기능은 별도 선택입니다. 이 화면은 마이크·유료 API·음성 재생을 시작하지 않습니다.</p>
    {status ? <><p>음성 기능 {status.settings.enabled ? "켜짐" : "꺼짐"} · 로컬 모델 {status.models.filter(model => !model.online && model.installed).length}개 설치됨</p><p className="mono onboarding-file-path">{status.destination}</p>
      {status.models.map(model => <div className="onboarding-model-row" key={model.id}><strong>{model.label}</strong>
        <span>{model.online ? `온라인 · ${model.cost}` : model.installed ? "설치됨" : model.state === "downloading" ? `${bytes(model.receivedBytes)} 받는 중` : model.state === "error" ? "다운로드 중단" : "아직 받지 않음"}</span>
        <small>언어 {model.languages.join(", ")} · 모델 {bytes(model.downloadBytes)} · 실행 파일 {bytes(model.runtimeBytes)} · {model.license}</small>
        {!model.online && !api?.isRemote ? <div className="onboarding-extra-actions">
          <button type="button" className="button small" disabled={busy || !model.supported || model.installed || model.state === "downloading"} onClick={() => void change(model.id, "download")}>모델 다운로드 · {bytes(model.downloadBytes)}</button>
          {model.state === "downloading" ? <button type="button" className="button small" disabled={busy} onClick={() => void change(model.id, "cancel")}>다운로드 취소</button> : null}
        </div> : null}
        {!model.supported ? <small>이 호스트에서는 지원하지 않습니다.</small> : null}
        {model.error ? <small className="warn">{model.error}</small> : null}
      </div>)}
      <p className="muted">받아쓰기·읽어주기와 온라인 사용 동의는 대화 입력창의 ‘음성 입력’에서 고릅니다. 원격 호스트의 모델 설치는 해당 PC에서 진행합니다.</p>
    </> : <p>{api ? "상태를 불러오는 중입니다." : "호스트에 연결하면 모델 상태를 볼 수 있습니다."}</p>}
    {error ? <p role="alert" className="warn">{error}</p> : null}
    <button type="button" className="text-button" onClick={refresh} disabled={!api || busy}>모델 상태 다시 확인</button>
  </details>;
}
