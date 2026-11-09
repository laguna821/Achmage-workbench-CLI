import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceModel, VoiceSettings, VoiceSpeech, VoiceStatus } from "../../../../packages/contracts/src/voice.ts";
import { createAudioEngine } from "../../../../vendor/paseo/voice-web/audio-engine.web.ts";
import type { AudioEngine } from "../../../../vendor/paseo/voice-web/audio-engine-types.ts";
import type { Api } from "../api.ts";
import { VoiceEnvironment } from "../voice/context.ts";
import { VoiceCaptureController, type CaptureView, type VoiceScope } from "../voice/capture.ts";
import "../styles/optional-features.css";

const bytes = (value: number | null) => value === null ? "미정" : value === 0 ? "다운로드 없음" : `${(value / 1024 / 1024).toLocaleString("ko-KR", { maximumFractionDigits: 1 })} MB`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const PHASE: Record<CaptureView["phase"], string> = { idle: "녹음 대기", starting: "마이크 준비 중…", recording: "녹음 중", transcribing: "받아쓰는 중…", ready: "내용을 확인한 뒤 입력에 추가하세요", cancelled: "취소됨", error: "받아쓰기 오류" };

function ModelDetails({ model }: { model: VoiceModel | undefined }) {
  if (!model) return null;
  return <div className="voice-model-details"><p>{model.online ? `온라인 · ${model.destination ?? "외부 음성 서비스"}` : "이 PC에서 처리"} · {model.cost}</p><p>언어 {model.languages.join(", ")} · 다운로드 {bytes(model.downloadBytes)} · 설치 {bytes(model.installedBytes)} · 실행 {bytes(model.runtimeBytes)}</p><details><summary>모델 출처·검증 정보</summary><p>{model.license} · {model.revision}</p><p className="feature-mono">{model.sourceUrl}</p><p className="feature-mono">SHA-256 {model.sha256 ?? "온라인 서비스 — 다운로드 해시 없음"}</p><p>지원 환경 {model.platforms.join(", ")}</p></details>{model.error ? <p role="alert">{model.error}</p> : null}</div>;
}

/** Capture is opt-in; review text stays separate until the user explicitly appends it. */
export function VoiceInput({ draftId, scope, disabled, onApply, reply, resetVersion = 0 }: {
  draftId: string; scope: VoiceScope; disabled?: boolean;
  onApply: (draftId: string, text: string) => boolean; reply?: string; resetVersion?: number;
}) {
  const api = useContext(VoiceEnvironment);
  return api ? <VoiceControls key={`${draftId}:${scope.sessionId}`} api={api} draftId={draftId} scope={scope} disabled={disabled} onApply={onApply} reply={reply} resetVersion={resetVersion} /> : null;
}

function VoiceControls({ api, draftId, scope, disabled, onApply, reply, resetVersion }: Parameters<typeof VoiceInput>[0] & { api: Api }) {
  const [open, setOpen] = useState(false), [status, setStatus] = useState<VoiceStatus | null>(null), [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [apiKey, setApiKey] = useState(""), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const [view, setView] = useState<CaptureView>({ phase: "idle", text: "", volume: 0, error: null });
  const [review, setReview] = useState(""), [readEnabled, setReadEnabled] = useState(false), [muted, setMuted] = useState(true), [speaking, setSpeaking] = useState(false);
  const live = useRef(true), speech = useRef<{ id: string; abort: AbortController; engine: AudioEngine } | null>(null);
  const lastReset = useRef(resetVersion);
  const capture = useMemo(() => new VoiceCaptureController(api, next => { if (live.current) { setView(next); if (next.phase === "ready") setReview(next.text); } }), [api]);
  const stopSpeech = () => {
    const current = speech.current; speech.current = null;
    if (current) { current.abort.abort(); current.engine.stop(); current.engine.clearQueue(); void current.engine.destroy().catch(() => undefined); void api.request<{ ok: true }>("POST", `/api/voice/speech/${encodeURIComponent(current.id)}/cancel`, {}).catch(() => undefined); }
    if (live.current) setSpeaking(false);
  };
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; capture.cancel(false); stopSpeech(); };
  }, [capture]);
  useEffect(() => {
    if (lastReset.current === resetVersion) return;
    lastReset.current = resetVersion; capture.cancel(); setReview(""); stopSpeech();
  }, [capture, resetVersion]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = () => api.request<VoiceStatus>("GET", "/api/voice").then(next => { if (active) { setStatus(next); setSettings(current => api.isRemote ? next.settings : current ?? next.settings); } }, reason => { if (active) setError(errorText(reason)); });
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [api, open]);
  const running = ["starting", "recording", "transcribing"].includes(view.phase);
  const stt = status?.models.find(model => model.id === settings?.sttModelId), tts = status?.models.find(model => model.id === settings?.ttsModelId);
  const changed = !!settings && JSON.stringify(settings) !== JSON.stringify(status?.settings);
  const available = !!status?.settings.enabled && !!stt?.supported && (stt.online ? status.settings.onlineConsent && status.apiKeyConfigured : stt.installed) && !changed;
  const perform = async (action: () => Promise<VoiceStatus>) => { setSaving(true); setError(""); try { const next = await action(); if (live.current) { setStatus(next); setSettings(next.settings); setApiKey(""); } } catch (reason) { if (live.current) setError(errorText(reason)); } finally { if (live.current) setSaving(false); } };
  const readReply = async () => {
    if (!reply || !status || !readEnabled || muted || speaking || !tts?.supported || (tts.online && (!status.settings.onlineConsent || !status.apiKeyConfigured))) return;
    setError(""); setSpeaking(true);
    const current = { id: crypto.randomUUID(), abort: new AbortController(), engine: createAudioEngine({ onCaptureData: () => {}, onVolumeLevel: () => {}, onError: problem => { if (live.current) setError(problem.message); } }) };
    speech.current = current;
    try {
      await current.engine.initialize();
      if (speech.current !== current || current.abort.signal.aborted) return;
      const result = await api.request<VoiceSpeech>("POST", "/api/voice/speech", { speechId: current.id, sessionId: scope.sessionId, text: reply, onlineConsent: status.settings.onlineConsent }, { signal: current.abort.signal });
      if (speech.current !== current || current.abort.signal.aborted) return;
      const raw = atob(result.audioBase64), audio = Uint8Array.from(raw, character => character.charCodeAt(0));
      await current.engine.play(new Blob([audio], { type: result.mimeType }), current.abort.signal);
    } catch (reason) { if (!current.abort.signal.aborted && live.current) setError(errorText(reason)); }
    finally { if (speech.current === current) { speech.current = null; if (live.current) setSpeaking(false); } await current.engine.destroy().catch(() => undefined); }
  };
  return <section className="voice-input" aria-label="음성 입력">
    <button type="button" className="ghost-button small" aria-expanded={open} onClick={() => { if (open) { capture.cancel(); stopSpeech(); } setOpen(!open); }}>음성 {running ? `· ${PHASE[view.phase]}` : "입력"}</button>
    {open ? <div className="voice-panel">
      {error || view.error ? <p className="notice notice-error compact" role="alert">{error || view.error}</p> : null}
      {!status || !settings ? <p role="status">음성 설정 불러오는 중…</p> : <>
        <p className="sheet-hint">마이크는 녹음 버튼을 누를 때만 사용합니다. 음성은 저장하지 않으며 받은 글은 직접 고칠 수 있습니다.</p>
        <details open={!status.settings.enabled}><summary>음성 사용·모델 설정 {status.settings.enabled ? "· 켜짐" : "· 꺼짐"}</summary>
          {api.isRemote ? <p>모델·계정 설정은 호스트 PC에서 변경합니다.</p> : null}
          <fieldset disabled={api.isRemote || running || saving || speaking}>
            <label className="feature-check"><input type="checkbox" checked={settings.enabled} onChange={event => setSettings({ ...settings, enabled: event.target.checked })} />음성 입력 사용</label>
            <label>받아쓰기 모델<select value={settings.sttModelId} onChange={event => setSettings({ ...settings, sttModelId: event.target.value })}>{status.models.filter(model => model.kind === "stt").map(model => <option key={model.id} value={model.id} disabled={!model.supported}>{model.label}{!model.supported ? " · 이 환경 미지원" : ""}</option>)}</select></label>
            <label>읽어 주기 모델<select value={settings.ttsModelId} onChange={event => setSettings({ ...settings, ttsModelId: event.target.value })}>{status.models.filter(model => model.kind === "tts").map(model => <option key={model.id} value={model.id} disabled={!model.supported}>{model.label}{!model.supported ? " · 이 환경 미지원" : ""}</option>)}</select></label>
            <label>받아쓰기 언어<input value={settings.language} placeholder="ko" onChange={event => setSettings({ ...settings, language: event.target.value })} /></label>
            <label className="feature-check"><input type="checkbox" checked={settings.onlineConsent} onChange={event => setSettings({ ...settings, onlineConsent: event.target.checked })} />선택한 온라인 모델에 음성·읽을 글 전송과 표시된 비용 동의</label>
            <label>온라인 서비스 API 키 {status.apiKeyConfigured ? "· 등록됨" : "· 미등록"}<input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="변경할 때만 입력" /></label>
            <button type="button" className="button small" disabled={!changed && !apiKey} onClick={() => void perform(() => api.request<VoiceStatus>("PUT", "/api/voice/settings", { ...settings, ...(apiKey ? { apiKey } : {}) }))}>음성 설정 저장</button>
          </fieldset>
          <ModelDetails model={stt} /><ModelDetails model={tts} />
          {!api.isRemote && stt && !stt.online ? <div className="feature-actions"><button type="button" className="button small" disabled={saving || running || !stt.supported || stt.installed || stt.state === "downloading"} onClick={() => void perform(() => api.request<VoiceStatus>("POST", `/api/voice/models/${encodeURIComponent(stt.id)}/download`, { accepted: true }))}>받아쓰기 모델 다운로드 · {bytes(stt.downloadBytes)}</button>{stt.state === "downloading" ? <><span>{bytes(stt.receivedBytes)} 받는 중</span><button type="button" className="button small" disabled={saving} onClick={() => void perform(() => api.request<VoiceStatus>("POST", `/api/voice/models/${encodeURIComponent(stt.id)}/cancel`, {}))}>다운로드 취소</button></> : null}</div> : null}
        </details>
        <div className="feature-actions">
          <button type="button" className="button small" disabled={disabled || running || saving || !available} onClick={() => { stopSpeech(); setReview(""); void capture.begin({ draftId, sessionId: scope.sessionId, onlineConsent: status.settings.onlineConsent, maxCaptureBytes: status.limits.maxCaptureBytes }); }}>녹음 시작</button>
          <button type="button" className="button small" disabled={view.phase !== "recording"} onClick={() => void capture.finish()}>녹음 끝내고 받아쓰기</button>
          <button type="button" className="button small" disabled={!running && !review && !speaking} onClick={() => { capture.cancel(); setReview(""); stopSpeech(); }}>음성 모두 중단</button>
          <span role="status">{PHASE[view.phase]}</span>{view.phase === "recording" ? <meter min={0} max={1} value={view.volume} aria-label="마이크 입력 크기" /> : null}
        </div>
        {changed ? <p className="sheet-hint">변경한 설정을 저장한 뒤 녹음하세요.</p> : !available ? <p className="sheet-hint">음성 사용을 켜고 사용할 수 있는 모델을 선택하세요. 로컬 모델은 먼저 다운로드해야 합니다.</p> : null}
        {view.phase === "ready" ? <div className="voice-review"><label>받아쓰기 확인·수정<textarea rows={3} value={review} onChange={event => setReview(event.target.value)} /></label><button type="button" className="button small primary" disabled={disabled || !review.trim()} onClick={() => { if (onApply(draftId, review)) { setReview(""); capture.cancel(); } }}>기존 입력 끝에 추가</button></div> : null}
        <details><summary>답변 읽어 주기</summary><label className="feature-check"><input type="checkbox" checked={readEnabled} onChange={event => { setReadEnabled(event.target.checked); if (!event.target.checked) stopSpeech(); }} />이 입력창에서 읽어 주기 사용</label><label className="feature-check"><input type="checkbox" checked={muted} onChange={event => { setMuted(event.target.checked); if (event.target.checked) stopSpeech(); }} />소리 끄기</label><p>{tts?.label ?? "선택된 모델 없음"} · {tts?.cost ?? ""}</p>{reply ? <details><summary>읽을 마지막 답변 확인</summary><pre className="feature-output">{reply}</pre></details> : <p className="sheet-hint">완료된 답변이 아직 없습니다.</p>}<div className="feature-actions"><button type="button" className="button small" disabled={!readEnabled || muted || speaking || running || !reply || !tts?.supported || changed || reply.length > status.limits.maxSpeechCharacters || !status.settings.enabled || (tts.online ? !status.settings.onlineConsent || !status.apiKeyConfigured : !tts.installed)} onClick={() => void readReply()}>마지막 답변 읽기</button><button type="button" className="button small" disabled={!speaking} onClick={stopSpeech}>읽기 중단</button></div><p className="sheet-hint">직접 누른 답변만 읽습니다. 최대 {status.limits.maxSpeechCharacters.toLocaleString()}자.</p></details>
      </>}
    </div> : null}
  </section>;
}
