import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ChannelKind, ChannelsState, DocumentTools, Provider, ProviderStatus } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { PaletteId, ThemePref } from "../theme.ts";
import { createOnboardingModel, type OnboardingStepId } from "../../../../vendor/paseo/onboarding/model.ts";
import { isImeComposingKeyboardEvent } from "../../../../vendor/paseo/mobile-web/keyboard-ime.ts";
import { PALETTES, PALETTE_CREDIT } from "./AppearanceSheet.tsx";
import { EngineCard, type EngineActions } from "./EngineSetup.tsx";
import { Icon } from "./Icon.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import { usePkm } from "./pkm/PkmContext.tsx";
import { MESSENGER_NEEDS } from "./phone-words.ts";
import "../styles/onboarding.css";

// The first run (atlas-look, 2026-11-15, the owner: "온보딩 설정화면 가운데 뜨는 화면도 atlas랑 거의 똑같이"):
// ONE panel in the centre of the window over the dimmed, inert shell — the steps listed on its left, the
// step on its right, the keys at the right pane's foot — and only three steps: 화면 (밝기 and 색 조합),
// AI 엔진 (Claude and Codex as rows), 휴대폰 메신저 (텔레그램 / Slack, 건너뛰기 always there). Everything
// the earlier steps offered stays in 설정 (the first project: the empty list's 새 프로젝트). The gate
// (prefs.onboarding) and the Paseo visit model stay; steps the model has that are not shown are passed over.

export { toolState } from "./Connections.tsx";

/** The steps a person sees, in order (the model's "projects" and "orchestration" are passed over). */
const SHOWN: OnboardingStepId[] = ["appearance", "providers", "phone"];
const STEP_LABELS: Record<OnboardingStepId, string> = {
  appearance: "화면", providers: "AI 엔진", projects: "첫 프로젝트", orchestration: "문서 도구", phone: "휴대폰 메신저",
};
const THEMES: { id: ThemePref; label: string; icon: "sun" | "moon" | "settings" }[] = [
  { id: "light", label: "밝게", icon: "sun" },
  { id: "dark", label: "어둡게", icon: "moon" },
  { id: "system", label: "시스템 따라", icon: "settings" },
];
// Two independent rows (the owner: both can be connected at once): each says its own state and has its own key.
const MESSENGERS: { id: ChannelKind; label: string; hint: string }[] = [
  { id: "telegram", label: "텔레그램", hint: "봇 하나를 만들어 이 PC와 잇습니다." },
  { id: "slack", label: "Slack", hint: "내 Slack에 앱 하나를 만들어 이 PC와 잇습니다." },
];
const ready = (status: ProviderStatus | undefined) => Boolean(status?.installed && status.loggedIn);

export type OnboardingProps = {
  providers: Partial<Record<Provider, ProviderStatus>>;
  tools: DocumentTools | null;
  engineActions: EngineActions;
  onRefresh(): void;
  onInstallIeum(): void;
  onDone(): void;
  api?: Api;
  hostLabel?: string;
  /** Keep the same original step visit while an existing setup dialog (설정 › 메신저) is in front. */
  suspended?: boolean;
  themePref?: ThemePref;
  onTheme?(pref: ThemePref): void;
  palette?: PaletteId;
  onPalette?(palette: PaletteId): void;
  /** Hands over to 설정 › 메신저 for that messenger (its own wizard); the first run comes back when it closes. */
  onOpenMessenger?(kind: ChannelKind): void;
  /** The launch's attribution line (LaunchCredit) when the app opens on the first run: the panel's last row. */
  foot?: ReactNode;
};

/** Original Paseo visit fencing and completion model; Workbench owns the existing settings/actions. */
export function Onboarding({ foot, providers, engineActions, onRefresh, onDone, api, hostLabel = "현재 PC", suspended = false, themePref = "system", onTheme, palette = "atlas", onPalette, onOpenMessenger }: OnboardingProps) {
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
  const surface = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), backdrop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    void model.ready.then(() => { if (active) model.reopen(hostLabel, { includePhoneStep: true }); });
    return () => { active = false; };
  }, [model, api]);
  const raw = flow.status === "open" ? flow.steps[flow.stepIndex]! : null;
  // The model may stand on a step not shown here: it is passed over, forwards.
  useEffect(() => { if (raw && !SHOWN.includes(raw)) model.goTo("phone"); }, [raw, model]);
  const step = raw && SHOWN.includes(raw) ? raw : null;
  const index = step ? SHOWN.indexOf(step) : 0;
  const shown = !effectiveSuspended && flow.status === "open" && step !== null;
  // 휴대폰 메신저: what is connected now, read again whenever the step is in front (e.g. back from 설정 › 메신저).
  const [channels, setChannels] = useState<ChannelsState | null>(null);
  useEffect(() => {
    if (!shown || step !== "phone" || !api) return;
    let live = true;
    void api.request<ChannelsState>("GET", "/api/channels").then(next => { if (live) setChannels(next); }).catch(() => undefined);
    return () => { live = false; };
  }, [shown, step, api]);
  // The first run holds the focus (design review I1): everything beside it and under it — the rail,
  // the list, the panes and their composer — is inert while it is up, so Tab, a screen reader and a
  // stray autofocus stay inside the panel. Only what this sets is taken back.
  useLayoutEffect(() => {
    const root = backdrop.current;
    if (!shown || !root) return;
    const marked: Element[] = [];
    for (let node: Element | null = root; node && node !== document.body && node.parentElement; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling === node || sibling.hasAttribute("inert") || sibling.tagName === "SCRIPT") continue;
        sibling.setAttribute("inert", ""); marked.push(sibling);
      }
    }
    return () => marked.forEach((element) => element.removeAttribute("inert"));
  }, [shown]);
  useLayoutEffect(() => {
    if (effectiveSuspended || flow.status !== "open") return;
    const opener = document.activeElement, dialog = surface.current;
    heading.current?.focus({ preventScroll: true });
    // A view under it that focuses its own field after mounting does not take the focus away.
    const again = requestAnimationFrame(() => {
      if (!(document.activeElement instanceof Node) || !dialog?.contains(document.activeElement)) heading.current?.focus({ preventScroll: true });
    });
    return () => { cancelAnimationFrame(again); restoreSurfaceFocus(opener, dialog); };
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
  if (flow.status !== "open" || effectiveSuspended || !step) return null;
  const last = index === SHOWN.length - 1;
  const next = () => last ? model.next(flow.visit) : model.goTo(SHOWN[index + 1]!);
  const back = () => model.goTo(SHOWN[index - 1]!);
  const finish = () => void model.complete();
  const anyEngine = ready(providers.claude) || ready(providers.codex);
  // One filled key per step (I2): with no engine ready the engine rows' keys are the way on, so 'AI 없이 계속' is quiet.
  const quietNext = step === "providers" && !anyEngine;

  return <div ref={backdrop} className="onboarding-backdrop onboarding-first" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" onKeyDown={event => {
    if (event.key !== "Tab") return;
    const nodes = [...(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])].filter(node => node.getClientRects().length > 0);
    const first = nodes[0], lastNode = nodes.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); lastNode?.focus(); }
    else if (!event.shiftKey && document.activeElement === lastNode) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="onboarding" ref={surface}>
      <nav className="onboarding-side" aria-label="처음 설정">
        <p className="onboarding-side-head">처음 설정</p>
        <ol className="onboarding-steps" aria-label="처음 설정 단계">
          {SHOWN.map((id, at) => <li key={id} className={at === index ? "active" : at < index ? "done" : ""}>
            <button type="button" aria-current={at === index ? "step" : undefined} onClick={() => model.goTo(id)}>
              <span className="onboarding-step-no" aria-hidden>{at < index ? <Icon name="check" size={12} /> : at + 1}</span>{STEP_LABELS[id]}
            </button>
          </li>)}
        </ol>
        <p className="onboarding-side-note">모두 나중에 설정에서 바꿀 수 있습니다.</p>
      </nav>
      <section className="onboarding-pane">
        <div className="onboarding-page">
          <p className="onboarding-count">{index + 1} / {SHOWN.length}, {STEP_LABELS[step]}</p>
          {step === "appearance" ? <>
            <h2 id="onboarding-title" ref={heading} tabIndex={-1}>화면을 고르세요</h2>
            <p className="onboarding-lead">고르면 바로 바뀝니다. 나중에 설정 › 화면에서 바꿀 수 있습니다.</p>
            <div className="onboarding-look">
              <div className="onboarding-look-choices">
                <p className="onboarding-group-head" id="onboarding-theme-head">밝기</p>
                <div className="onboarding-tiles three" role="radiogroup" aria-labelledby="onboarding-theme-head">
                  {THEMES.map(theme => <button key={theme.id} type="button" role="radio" aria-checked={themePref === theme.id} className={`onboarding-tile${themePref === theme.id ? " chosen" : ""}`} onClick={() => onTheme?.(theme.id)}>
                    <Icon name={theme.icon} size={18} /><span>{theme.label}</span>
                  </button>)}
                </div>
                <p className="onboarding-group-head" id="onboarding-palette-head">색 조합</p>
                <div className="onboarding-tiles" role="radiogroup" aria-labelledby="onboarding-palette-head">
                  {PALETTES.map(choice => <button key={choice.id} type="button" role="radio" aria-checked={palette === choice.id} className={`onboarding-tile${palette === choice.id ? " chosen" : ""}`} onClick={() => onPalette?.(choice.id)}>
                    <span className={`onboarding-swatch swatch-${choice.id}`} aria-hidden><i /><i /><i /></span><span>{choice.label}</span>
                  </button>)}
                </div>
                <p className="onboarding-credit">{PALETTE_CREDIT}</p>
              </div>
              {/* The live preview: the shell's own tokens, so it is whatever was just chosen. */}
              <span className="onboarding-preview" role="img" aria-label="고른 화면 미리 보기">
                <span className="onboarding-preview-rail"><i className="current" /><i /><i /></span>
                <span className="onboarding-preview-list"><i className="current" /><i /><i /></span>
                <span className="onboarding-preview-work"><i /><i /><i className="key" /></span>
              </span>
            </div>
          </> : null}
          {step === "providers" ? <>
            <h2 id="onboarding-title" ref={heading} tabIndex={-1}>AI 엔진에 로그인하세요</h2>
            <p className="onboarding-lead">이 앱은 Claude나 Codex에게 일을 맡깁니다. 하나만 연결해도 됩니다.</p>
            <div className="onboarding-engines">
              {(["claude", "codex"] as const).map(provider => <EngineCard key={provider} provider={provider} status={providers[provider]} actions={engineActions} />)}
            </div>
            <p className="onboarding-note">로그인은 각 엔진의 로그인 페이지에서 하며, 암호를 이 앱에 넣지 않습니다. <button type="button" className="text-button" onClick={onRefresh}>다시 확인</button></p>
          </> : null}
          {step === "phone" ? <>
            <h2 id="onboarding-title" ref={heading} tabIndex={-1}>휴대폰 메신저로도 쓰기</h2>
            <p className="onboarding-lead">밖에서 휴대폰 메신저로 이 PC의 AI에게 일을 시키고 결과를 받습니다. {MESSENGER_NEEDS} 지금 하지 않아도 됩니다.</p>
            <ul className="onboarding-ways">
              {MESSENGERS.map(way => {
                const bot = channels?.bots.find(entry => entry.kind === way.id);
                const name = bot ? (bot.kind === "slack" ? bot.appName || bot.name : bot.username ? `@${bot.username}` : bot.name) : "";
                return <li key={way.id} data-messenger={way.id}><div><strong>{way.label} <span className={`onboarding-way-state${bot ? " on" : ""}`}>{bot ? `연결됨${name ? `, ${name}` : ""}` : "연결 안 됨"}</span></strong><span>{way.hint}</span></div>
                  {onOpenMessenger ? <button type="button" className="button small" aria-label={`${way.label} ${bot ? "열기" : "연결하기"}`} onClick={() => onOpenMessenger(way.id)}>{bot ? "열기" : "연결하기"}</button> : null}</li>;
              })}
            </ul>
            <p className="onboarding-note">{onOpenMessenger ? "설정 › 메신저가 열리고, 닫으면 이 안내로 돌아옵니다." : "이 PC의 앱에서 설정 › 메신저로 연결합니다."}</p>
          </> : null}
        </div>
        <div className="onboarding-actions">
          {index > 0 ? <button type="button" className="text-button" onClick={back}>이전</button> : null}<span className="spacer" />
          <button type="button" className="text-button" onClick={finish}>{last ? "건너뛰기" : "나중에 설정"}</button>
          <button type="button" className={quietNext ? "button" : "button primary"} onClick={next}>{last ? "시작하기" : quietNext ? "AI 없이 계속" : "다음"}</button>
        </div>
      </section>
      {foot ? <div className="onboarding-foot">{foot}</div> : null}
    </div>
  </div>;
}
