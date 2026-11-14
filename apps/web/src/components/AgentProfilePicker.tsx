import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ACCESS_LABEL, ACCESS_MODES, EFFORT_LABEL, PROVIDER_LABEL, type AgentProfile, type AgentProfileInput, type ModelOption, type Provider, type Session } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import { plainModelLabel } from "./ModelPicker.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import "../styles/agent-profiles.css";

type ProfileApi = Pick<Api, "agentProfiles" | "saveAgentProfile" | "removeAgentProfile" | "updateSession">;
type ModelsByProvider = Partial<Record<Provider, ModelOption[]>>;
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const compatible = (profile: AgentProfile, provider: Provider) => !profile.provider || profile.provider === provider;
const emptyProfile = (): AgentProfileInput => ({ name: "", provider: null, model: null, effort: null, access: null, instructions: "" });

function ProfileEditor({ profile, provider, models, onRefreshModels, onSave, onDelete, onClose }: {
  profile: AgentProfile | null; provider: Provider; models: ModelsByProvider;
  onRefreshModels?: (provider: Provider) => Promise<unknown>;
  onSave: (input: AgentProfileInput) => Promise<void>; onDelete: () => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState<AgentProfileInput>(() => profile ? { ...profile } : emptyProfile());
  const [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false), [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement), pending = useRef(false);
  const mounted = useRef(true), composing = useRef(false);
  const titleId = useId(), modelListId = useId(), effortListId = useId();
  const engine = draft.provider ?? provider;
  const discovered = models[engine] ?? [];
  const known = discovered.find(model => model.id === draft.model);
  const efforts = known?.efforts ?? [...new Set(discovered.flatMap(model => model.efforts))];
  useLayoutEffect(() => {
    const surface = dialog.current;
    surface?.showModal();
    return () => restoreSurfaceFocus(opener.current, surface);
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await operation(); } catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="agent-profile-editor" aria-labelledby={titleId} aria-busy={busy} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <form onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} onSubmit={event => {
      event.preventDefault();
      if (composing.current || !draft.name.trim()) return;
      void run(() => onSave({ name: draft.name.trim(), provider: draft.provider, model: draft.model?.trim() || null, effort: draft.effort?.trim() || null, access: draft.access, instructions: draft.instructions }));
    }}>
      <header><h2 id={titleId}>{profile ? "역할 편집" : "새 역할 만들기"}</h2><button type="button" className="icon-button" aria-label="역할 편집 닫기" disabled={busy} onClick={onClose}><Icon name="x" size={17} /></button></header>
      <p className="muted">다음 요청부터 적용합니다. 이 대화에서 직접 정한 모델·강도·권한이 역할보다 우선합니다.</p>
      <fieldset disabled={busy}>
        <label>역할 이름<input autoFocus required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <div className="profile-field-pair">
          <label>사용할 엔진<select value={draft.provider ?? ""} onChange={event => setDraft({ ...draft, provider: (event.target.value || null) as Provider | null })}>
            <option value="">대화의 엔진 따르기</option>{(["claude", "codex"] as const).map(value => <option key={value} value={value}>{PROVIDER_LABEL[value]}</option>)}
          </select></label>
          <label>기본 권한<select value={draft.access ?? ""} onChange={event => setDraft({ ...draft, access: (event.target.value || null) as AgentProfileInput["access"] })}>
            <option value="">대화 기본값</option>{ACCESS_MODES.map(value => <option key={value} value={value}>{ACCESS_LABEL[value]}</option>)}
          </select></label>
        </div>
        <label>기본 모델 ID<input list={modelListId} value={draft.model ?? ""} placeholder="비워 두면 엔진 기본값" onChange={event => setDraft({ ...draft, model: event.target.value || null })} /></label>
        <datalist id={modelListId}>{discovered.map(model => <option key={model.id} value={model.id}>{plainModelLabel(model.label)}</option>)}</datalist>
        <div className="profile-model-help"><small className="muted">{discovered.length ? `${PROVIDER_LABEL[engine]}에서 확인한 모델 ${discovered.length}개 · ID 직접 입력 가능` : `${PROVIDER_LABEL[engine]}의 모델 목록이 없습니다. ID를 직접 입력할 수 있습니다.`}</small>
          {onRefreshModels ? <button type="button" className="link" disabled={refreshing} onClick={async () => {
            setRefreshing(true); setError("");
            try { await onRefreshModels(engine); } catch (reason) { if (mounted.current) setError(errorText(reason)); }
            finally { if (mounted.current) setRefreshing(false); }
          }}>{refreshing ? "확인 중…" : "모델 목록 확인"}</button> : null}
        </div>
        <label>기본 추론 강도<input list={effortListId} value={draft.effort ?? ""} placeholder="비워 두면 모델 기본값" onChange={event => setDraft({ ...draft, effort: event.target.value || null })} /></label>
        <datalist id={effortListId}>{efforts.map(effort => <option key={effort} value={effort}>{EFFORT_LABEL[effort] ?? effort}</option>)}</datalist>
        <label>역할 지침<textarea rows={5} value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} placeholder="이 역할로 요청할 때 함께 전달할 지침" /></label>
      </fieldset>
      {draft.provider && draft.provider !== provider ? <p className="muted">저장한 역할은 {PROVIDER_LABEL[draft.provider]} 대화에서 선택할 수 있습니다. 현재 대화의 엔진은 바뀌지 않습니다.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {confirmDelete ? <div className="profile-delete-confirm"><p>‘{profile?.name}’ 역할을 삭제할까요?</p><p className="muted">이미 접수한 요청의 설정은 그대로 남습니다.</p><button type="button" className="button danger" disabled={busy} onClick={() => void run(onDelete)}>삭제하기</button><button type="button" className="button" disabled={busy} onClick={() => setConfirmDelete(false)}>취소</button></div> : null}
      <footer>{profile ? <button type="button" className="link danger" disabled={busy} onClick={() => setConfirmDelete(true)}>역할 삭제…</button> : <small className="muted">저장한 역할은 다른 대화에서도 선택할 수 있습니다.</small>}<button type="submit" className="button primary" disabled={busy || !draft.name.trim()}>{busy ? "처리 중…" : "저장"}</button></footer>
    </form>
  </dialog>, document.body);
}

/** Host profiles are defaults for the next request; selecting one never changes the engine. */
export function AgentProfilePicker({ api, session, models, onRefreshModels, onResolved, onNotice }: {
  api: ProfileApi; session: Pick<Session, "id" | "provider" | "profileId">; models: ModelsByProvider;
  onRefreshModels?: (provider: Provider) => Promise<unknown>;
  onResolved?: (profile: AgentProfile | null) => void; onNotice?: (message: string) => void;
}) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]), [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [open, setOpen] = useState(false), [editing, setEditing] = useState<{ profile: AgentProfile | null } | null>(null);
  const request = useRef(0), mounted = useRef(true), pending = useRef(false), trigger = useRef<HTMLButtonElement>(null);
  const resolved = useRef(onResolved); resolved.current = onResolved;
  const selected = profiles.find(profile => profile.id === session.profileId && compatible(profile, session.provider)) ?? null;
  const load = useCallback(async () => {
    const version = ++request.current;
    setLoading(true); setError("");
    try { const result = await api.agentProfiles(); if (mounted.current && request.current === version) { setProfiles(result.profiles); setLoaded(true); } }
    catch (reason) { if (mounted.current && request.current === version) setError(errorText(reason)); }
    finally { if (mounted.current && request.current === version) setLoading(false); }
  }, [api]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; ++request.current; }; }, [load]);
  useEffect(() => { resolved.current?.(selected); }, [selected, session.id]);
  const close = useCallback(() => setOpen(false), []);
  const edit = (profile: AgentProfile | null) => {
    trigger.current?.focus(); setOpen(false); setEditing({ profile });
  };
  const choose = async (profileId: string | null) => {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError("");
    try { await api.updateSession(session.id, { profileId }); if (mounted.current) setOpen(false); }
    catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { pending.current = false; if (mounted.current) setSaving(false); }
  };
  return <div className="anchor agent-profile-picker">
    <button ref={trigger} type="button" className="plain-select" aria-label={`역할: ${selected?.name ?? (session.profileId ? loading ? "불러오는 중" : "확인 필요" : "없음")}`} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open); if (!open && loaded) void load(); }}>
      역할 · {selected?.name ?? (session.profileId ? loading ? "불러오는 중…" : "확인 필요" : "없음")}<Icon name={open ? "chevronUp" : "chevronDown"} size={13} />
    </button>
    <Popover open={open} onClose={close} placement="above" align="right" className="agent-profile-menu" label="대화 역할">
      <div className="menu-label">역할 · 다음 요청부터 적용</div>
      <p className="profile-menu-note">직접 선택한 모델·강도·권한을 우선합니다. 실행 중인 요청은 유지합니다.</p>
      {loading ? <div className="menu-label" role="status">역할을 불러오는 중…</div> : null}
      {error ? <div className="menu-label" role="alert">{error}</div> : null}
      {loaded && session.profileId && !selected ? <div className="menu-label" role="status">저장된 역할이 없거나 현재 엔진과 맞지 않습니다. 역할을 다시 선택해 주세요.</div> : null}
      <MenuItem active={!session.profileId} disabled={saving} disabledReason="역할 선택을 저장하고 있습니다." onSelect={() => void choose(null)}>역할 없음</MenuItem>
      {profiles.filter(profile => compatible(profile, session.provider)).map(profile => <MenuItem key={profile.id} active={profile.id === session.profileId} disabled={saving} disabledReason="역할 선택을 저장하고 있습니다." hint={profile.model ?? (profile.provider ? PROVIDER_LABEL[profile.provider] : "대화 엔진")} onSelect={() => void choose(profile.id)}>{profile.name}</MenuItem>)}
      <div className="menu-divider" />
      {selected ? <MenuItem onSelect={() => edit(selected)}>선택한 역할 편집…</MenuItem> : null}
      <MenuItem onSelect={() => edit(null)}>새 역할 만들기…</MenuItem>
      <MenuItem disabled={loading} disabledReason="역할 목록을 확인하고 있습니다." onSelect={() => void load()}>목록 새로고침</MenuItem>
    </Popover>
    {editing ? <ProfileEditor profile={editing.profile} provider={session.provider} models={models} onRefreshModels={onRefreshModels} onClose={() => setEditing(null)} onSave={async input => {
      const saved = await api.saveAgentProfile(input, editing.profile?.id, editing.profile?.revision);
      if (!mounted.current) return;
      ++request.current; setLoading(false); setLoaded(true); setError("");
      setProfiles(current => [...current.filter(profile => profile.id !== saved.id), saved]); setEditing(null);
      onNotice?.(`‘${saved.name}’ 역할을 저장했습니다.`);
    }} onDelete={async () => {
      if (!editing.profile) return;
      const profile = editing.profile;
      await api.removeAgentProfile(profile.id, profile.revision);
      if (!mounted.current) return;
      ++request.current; setLoading(false); setError("");
      setProfiles(current => current.filter(item => item.id !== profile.id)); setEditing(null);
      onNotice?.(`‘${profile.name}’ 역할을 삭제했습니다.`);
    }} /> : null}
  </div>;
}
