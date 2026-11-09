import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Artifact, DocumentTools, Provider, ProviderStatus, ToolStatus } from "@workbench/contracts";
import type { DropboxState } from "../../../../packages/contracts/src/dropbox.ts";
import type { Api } from "../api.ts";
import { createOnboardingModel, type OnboardingStepId } from "../../../../vendor/paseo/onboarding/model.ts";
import { isImeComposingKeyboardEvent } from "../../../../vendor/paseo/mobile-web/keyboard-ime.ts";
import { EngineCard, engineState, type EngineActions } from "./EngineSetup.tsx";
import { OnboardingModelCache } from "./onboarding/ModelCache.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import { usePkm } from "./pkm/PkmContext.tsx";
import "../styles/onboarding.css";

/** Shared by Connections: reflect setup/registration separately from merely finding the binary. */
export function toolState(status: ToolStatus) {
  if (status.setup === "error") return { text: "설정 중단", tone: "warn" };
  if (status.setup === "checking") return { text: "앱 확인 중…", tone: "" };
  if (status.setup === "registering") return { text: "OS에 등록 중…", tone: "" };
  if (status.busy || status.setup === "installing") return { text: "설치 중…", tone: "" };
  if (status.registered === true) return { text: `독립 앱 등록·연결됨${status.version ? ` · ${status.version}` : ""}`, tone: "ok" };
  if (status.registered === false && status.available) return { text: "앱 있음 · OS 등록 필요", tone: "warn" };
  if (status.bundled) return { text: `앱에 포함${status.version ? ` · ${status.version}` : ""}`, tone: "ok" };
  if (status.available) return { text: `사용 가능${status.version ? ` · ${status.version}` : ""}`, tone: "ok" };
  return { text: "아직 없음", tone: "warn" };
}

const STEP_LABELS: Record<OnboardingStepId, string> = {
  appearance: "환영", providers: "AI 연결", projects: "작업 폴더", orchestration: "문서 도구", phone: "시작하기",
};

export type OnboardingProps = {
  providers: Partial<Record<Provider, ProviderStatus>>;
  tools: DocumentTools | null;
  engineActions: EngineActions;
  onRefresh(): void;
  onInstallIeum(): void;
  onDone(): void;
  api?: Api;
  hostLabel?: string;
  /** Keep the same original step visit while an existing setup dialog is in front. */
  suspended?: boolean;
  artifacts?: Artifact[];
  onOpenDropbox?(): void;
  onOpenVault?(): void;
  onOpenDevices?(): void;
  onOpenDocument?(artifactId: string): void;
  onCreateDocument?(): void;
  onImportHistory?(): void;
};

/** Original Paseo visit fencing and completion model; Workbench owns the existing settings/actions. */
export function Onboarding({ providers, tools, engineActions, onRefresh, onInstallIeum, onDone, api, hostLabel = "현재 PC", suspended = false, artifacts = [], onOpenDropbox, onOpenVault, onOpenDevices, onOpenDocument, onCreateDocument, onImportHistory }: OnboardingProps) {
  const pkm = usePkm();
  const effectiveSuspended = suspended || Boolean(pkm.dialog);
  const done = useRef(onDone); done.current = onDone;
  const refreshAction = useRef(onRefresh); refreshAction.current = onRefresh;
  const [model] = useState(() => createOnboardingModel({ storage: {
    // App already gates first-run/reopen with its existing prefs.onboarding; no second record.
    isCompleted: async () => false,
    markCompleted: async () => done.current(),
  } }));
  const flow = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const surface = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    let active = true;
    void model.ready.then(() => { if (active) model.reopen(hostLabel, { includePhoneStep: true }); });
    return () => { active = false; };
  }, [model, api]);
  const step = flow.status === "open" ? flow.steps[flow.stepIndex]! : null;
  useLayoutEffect(() => {
    if (effectiveSuspended || flow.status !== "open") return;
    const opener = document.activeElement, dialog = surface.current;
    heading.current?.focus({ preventScroll: true });
    return () => restoreSurfaceFocus(opener, dialog);
  }, [effectiveSuspended, step]);
  useEffect(() => {
    if (effectiveSuspended || flow.status !== "open") return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeComposingKeyboardEvent(event) || event.defaultPrevented) return;
      if (!(event.target instanceof Node) || !surface.current?.contains(event.target)) return;
      event.preventDefault(); event.stopPropagation(); void model.complete();
    };
    const refresh = () => { if (document.visibilityState === "visible") refreshAction.current(); };
    window.addEventListener("keydown", key); window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    refreshAction.current();
    return () => {
      window.removeEventListener("keydown", key); window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [model, effectiveSuspended, flow.status]);
  if (flow.status !== "open" || effectiveSuspended) return null;
  const standalone = tools?.ieumApp;
  const chosen = artifacts.find(artifact => artifact.id === selected && artifact.diskState !== "missing") ?? artifacts.find(artifact => artifact.diskState !== "missing");
  const useDocument = () => {
    if (!chosen || !onOpenDocument) return;
    void model.complete(); onOpenDocument(chosen.id);
  };
  return <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" onKeyDown={event => {
    if (event.key !== "Tab") return;
    const nodes = [...(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])].filter(node => node.getClientRects().length > 0);
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="onboarding" ref={surface}>
      <p className="onboarding-host">설정 대상 · {hostLabel}</p>
      <ol className="onboarding-steps">
        {flow.steps.map((id, index) => <li key={id} className={index === flow.stepIndex ? "active" : index < flow.stepIndex ? "done" : ""}>
          <button type="button" aria-current={index === flow.stepIndex ? "step" : undefined} onClick={() => model.goTo(id)}>{STEP_LABELS[id]}</button>
        </li>)}
      </ol>
      {step === "appearance" ? <section>
        <h2 id="onboarding-title" ref={heading} tabIndex={-1}>작업을 시작할 준비</h2>
        <p>Codex·Claude Code 계정을 연결하고, Dropbox 작업 폴더와 독립 이음오피스를 이어 씁니다. 이미 설치한 도구와 설정은 그대로 사용합니다.</p>
        <ol className="onboarding-path"><li>필요한 CLI 설치 → 기존 계정 로그인</li><li>Dropbox 폴더 연결 → 원래 위치의 문서 열기</li><li>독립 이음 앱 설치·OS 등록 → 같은 파일 열기·저장·복귀</li></ol>
        <p className="onboarding-notice">AI 계정 연결 없이도 내장 편집기에서 새 문서를 만들고 편집할 수 있습니다. 필요한 설정만 진행하고 나머지는 나중에 돌아와도 됩니다.</p>
      </section> : null}
      {step === "providers" ? <section>
        <h2 id="onboarding-title" ref={heading} tabIndex={-1}>Codex와 Claude 연결</h2>
        <p>설치와 로그인은 이 호스트의 기존 연결 기능으로 진행합니다. 계정 암호를 Workbench에 입력하지 않습니다.</p>
        {(["codex", "claude"] as const).map(provider => <div key={provider} className="onboarding-card"><EngineCard provider={provider} status={providers[provider]} actions={engineActions} /></div>)}
        <p className="onboarding-notice">요청과 첨부 문서는 선택한 AI 제공자에게 전달됩니다. 구독·종량제 상태를 확인한 뒤 사용하세요.</p>
        <button type="button" className="text-button" onClick={onRefresh}>설치·로그인 상태 다시 확인</button>
      </section> : null}
      {step === "projects" ? <section>
        <h2 id="onboarding-title" ref={heading} tabIndex={-1}>Dropbox부터 연결</h2>
        <p>Dropbox 앱이 동기화하는 폴더를 연결합니다. 문서를 복제하거나 옮기지 않고 같은 파일을 Workbench와 이음오피스에서 사용합니다.</p>
        <DropboxStatus api={api} onOpen={onOpenDropbox} />
        <div className="onboarding-card"><strong>옵시디언 볼트 · 읽기 전용</strong><p>찾아보기와 인용에 사용할 기존 볼트를 연결합니다. 노트의 내용·태그·링크는 자동으로 고치지 않습니다.</p>
          {onOpenVault ? <button type="button" className="button" onClick={onOpenVault}>볼트 연결·설정</button> : <p className="muted">연결과 설정에서 볼트를 고를 수 있습니다.</p>}
        </div>
        <p className="muted">Dropbox 동기화 진행과 오프라인 사용 여부는 Dropbox 앱에서 확인하세요. Google Drive 전용 연결은 아직 제공하지 않습니다. 로컬 폴더로도 작업을 시작할 수 있습니다.</p>
      </section> : null}
      {step === "orchestration" ? <section>
        <h2 id="onboarding-title" ref={heading} tabIndex={-1}>독립 이음 앱까지 연결</h2>
        <p>내장 편집기와 별도 이음오피스 앱을 함께 씁니다. 독립 앱은 Workbench 설치·첫 실행 때 준비하며, 중단된 설치와 OS 등록은 아래에서 이어갈 수 있습니다.</p>
        <div className="onboarding-card">
          <div className="connection-head"><strong>이음오피스 독립 앱</strong><span className={`connection-state ${standalone ? toolState(standalone).tone : "warn"}`}>{standalone ? toolState(standalone).text : "설치 상태 확인 필요"}</span></div>
          {standalone?.message ? <p role="status">{standalone.message}</p> : null}
          {standalone?.path ? <p className="mono onboarding-file-path">{standalone.path}</p> : null}
          <p>OS 앱 목록에 등록한 독립 앱입니다. 문서의 ‘앱으로 열기’가 현재 파일 경로를 이 앱으로 전달합니다.</p>
          <button type="button" className="button primary" onClick={onInstallIeum}>{standalone?.busy ? "설치 진행 보기" : standalone?.registered ? "독립 앱 연결·업데이트" : "독립 앱 설치·OS 등록"}</button>
        </div>
        <details className="onboarding-tool-details"><summary>내장 문서 도구 상태</summary>
          {tools ? ([{ name: "이음오피스 문서 편집기", status: tools.ieumoffice }, { name: "hallym-kordoc 스킬", status: tools.kordoc }, ...(tools.hwp ? [{ name: "이음 한글", status: tools.hwp }] : []), ...(tools.pdf ? [{ name: "이음 PDF", status: tools.pdf }] : [])]).map(row => <p key={row.name}>{row.name} <span className="muted">· {toolState(row.status).text}</span></p>) : <p>도구 상태를 불러오는 중입니다.</p>}
        </details>
        <OnboardingModelCache api={api} />
      </section> : null}
      {step === "phone" ? <section>
        <h2 id="onboarding-title" ref={heading} tabIndex={-1}>같은 문서로 이어서 작업</h2>
        <div className="onboarding-ready-list">
          {(["codex", "claude"] as const).map(provider => <span key={provider}>{provider === "codex" ? "Codex" : "Claude Code"} · {engineState(providers[provider]).text}</span>)}
          <span>이음 독립 앱 · {standalone ? toolState(standalone).text : "설정에서 확인"}</span>
        </div>
        <ol className="onboarding-path"><li>아래 문서를 열고 상단 ‘앱으로 열기’를 누릅니다. 미저장 내용은 먼저 저장합니다.</li><li>독립 이음 앱에서 같은 파일을 편집하고 저장합니다.</li><li>Workbench로 돌아오면 외부 저장을 새 판으로 받아 이어갑니다. 동시 편집 충돌은 덮어쓰지 않고 표시합니다.</li></ol>
        {chosen && onOpenDocument ? <div className="onboarding-card">
          <label htmlFor="onboarding-document">이어서 사용할 문서</label>
          <select id="onboarding-document" value={chosen.id} onChange={event => setSelected(event.target.value)}>{artifacts.filter(artifact => artifact.diskState !== "missing").map(artifact => <option key={artifact.id} value={artifact.id}>{artifact.name}</option>)}</select>
          <p className="mono onboarding-file-path">{chosen.path}</p>
          <button type="button" className="button primary" onClick={useDocument}>안내를 마치고 이 문서 열기</button>
        </div> : <p className="muted">아직 열린 문서가 없습니다. Dropbox에서 문서를 열거나 새 문서를 만들어 시작하세요.</p>}
        <div className="onboarding-extra-actions">
          {onCreateDocument ? <button type="button" className="button" onClick={() => { void model.complete(); onCreateDocument(); }}>AI 없이 새 문서</button> : null}
          {onOpenDropbox ? <button type="button" className="button" onClick={onOpenDropbox}>Dropbox 문서·프로젝트 열기</button> : null}
          {onOpenDevices ? <button type="button" className="button" onClick={onOpenDevices}>휴대폰·다른 기기 연결</button> : null}
          {onImportHistory ? <button type="button" className="text-button" onClick={onImportHistory}>CLI 대화 기록 가져오기</button> : null}
        </div>
        <p className="muted">가져온 대화는 보관 기록입니다. 옛 요청을 자동으로 실행하지 않습니다. 휴대폰은 호스트의 QR 또는 연결 링크로 연결합니다.</p>
      </section> : null}
      <div className="onboarding-actions">
        <button type="button" className="text-button" onClick={() => void model.complete()}>나중에 설정</button><span className="spacer" />
        {flow.stepIndex > 0 ? <button type="button" className="button" onClick={model.back}>이전</button> : null}
        <button type="button" className="button primary" onClick={() => model.next(flow.visit)}>{flow.stepIndex < flow.steps.length - 1 ? "다음" : "시작하기"}</button>
      </div>
    </div>
  </div>;
}

function DropboxStatus({ api, onOpen }: { api?: Api; onOpen?: () => void }) {
  const [state, setState] = useState<DropboxState | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    setState(null); setError(null);
    void api.request<DropboxState>("GET", "/api/dropbox").then(value => { if (active) setState(value); }, reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [api]);
  return <div className="onboarding-card">
    <strong>{state?.selected ? state.selected.available ? "Dropbox 폴더 연결됨" : "연결 폴더를 현재 찾을 수 없음" : "Dropbox 폴더 선택"}</strong>
    {state?.selected ? <p className="mono onboarding-file-path">{state.selected.path}</p> : <p>호스트에서 찾은 동기화 폴더를 고르거나 이미 사용하는 폴더를 지정합니다.</p>}
    {error ? <p role="alert" className="warn">{error}</p> : null}
    {onOpen ? <button type="button" className="button primary" onClick={onOpen}>{state?.selected ? "Dropbox 문서·프로젝트 열기" : "Dropbox 연결·폴더 선택"}</button> : <p className="muted">연결과 설정 → Dropbox 폴더 연결에서 이어갈 수 있습니다.</p>}
  </div>;
}
