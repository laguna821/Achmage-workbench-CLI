import type { ReactNode } from "react";
import { type AgentBrowserStatus, type DocumentTools, type Provider, type ProviderStatus } from "@workbench/contracts";
import { usageText } from "../format.ts";
import type { ThemePref } from "../theme.ts";
import { BrowserEngine, BrowserInstall, BrowserLogin, type BrowserActions } from "./BrowserPill.tsx";
import { EngineCard, type EngineActions } from "./EngineSetup.tsx";
import { toolState } from "./Onboarding.tsx";

const THEME_LABEL: Record<ThemePref, string> = { system: "시스템", light: "라이트", dark: "다크" };

/** Engine login and usage state. Shows only values the engines report; unknown stays unknown. */
/** Document engines: what each one does here and whether it is on this computer. */
function ToolsSection({ tools, onInstallIeum, onRefreshTools }: { tools: DocumentTools | null; onInstallIeum: () => void; onRefreshTools: () => void }) {
  if (!tools) return null;
  const rows = [
    { key: "kordoc", name: "hallym-kordoc 스킬", role: "Markdown·양식으로 HWPX 만들기 · 사용자 설치 스킬 우선", status: tools.kordoc },
    { key: "ieumoffice", name: "내장 이음오피스 편집기", role: "워드·PPT·엑셀 편집·저장·문서별 AI", status: tools.ieumoffice },
    ...(tools.ieumApp ? [{ key: "ieumApp", name: "이음오피스 앱 연결", role: "같은 파일을 앱으로 열고 저장 내용을 이어받기", status: tools.ieumApp } as const] : []),
    ...(tools.hwp ? [{ key: "hwp", name: "이음 한글", role: "앱 안에서 HWP·HWPX 편집·저장·출력", status: tools.hwp } as const] : []),
    ...(tools.pdf ? [{ key: "pdf", name: "이음 PDF", role: "앱 안에서 PDF 편집·쪽 정리·사본 저장", status: tools.pdf } as const] : []),
  ] as const;
  return (
    <>
      <div className="menu-divider" />
      <div className="menu-label">문서 도구</div>
      {rows.map((row) => {
        const state = toolState(row.status);
        return (
          <div key={row.key} className="connection">
            <div className="connection-head">
              <span className="connection-name">{row.name}</span>
              <span className={`connection-state ${state.tone}`}>{state.text}</span>
            </div>
            <div className="connection-meta muted">{row.role}</div>
            {row.status.message ? <div className="connection-meta">{row.status.message}</div> : null}
            {row.key === "ieumApp" && !row.status.busy ? (
              <button type="button" className="button small" onClick={onInstallIeum}>
                {row.status.available ? "연결 설정·업데이트" : "최신 이음오피스 설치·연결"}
              </button>
            ) : null}
          </div>
        );
      })}
      <button type="button" className="text-button" onClick={onRefreshTools}>
        문서 도구 다시 확인
      </button>
    </>
  );
}

/** The agent browser: installed or not, and signing in once for every session. */
function BrowserSection({ status, actions }: { status: AgentBrowserStatus | null; actions: BrowserActions }) {
  if (!status) return null;
  const install = status.install;
  const state =
    install.state === "ready" ? `준비됨 · ${status.engine === "lightpanda" ? "Lightpanda" : "Chromium"} ${install.browserVersion ?? ""}` : install.state === "installing" ? "설치 중…" : install.state === "error" ? "설치 실패" : "없음";
  return (
    <>
      <div className="menu-divider" />
      <div className="connection browser-connection">
        <div className="connection-head">
          <span className="connection-name">에이전트 브라우저</span>
          <span className={`connection-state ${install.state === "ready" ? "ok" : "warn"}`}>{state}</span>
        </div>
        <div className="connection-meta muted">{status.engine === "lightpanda" ? "Lightpanda가 화면 없이 AI의 웹 탐색과 정보 수집을 처리합니다." : "로그인·화면 검증·사이트 호환을 위해 Chromium을 사용합니다."}</div>
        <BrowserEngine status={status} actions={actions} />
        <BrowserInstall status={status} actions={actions} />
        {install.state === "ready" && status.engine !== "lightpanda" ? (
          <>
            <div className="connection-meta">로그인하기 · 에이전트와 같은 프로필에 한 번</div>
            <BrowserLogin status={status} actions={actions} />
          </>
        ) : null}
      </div>
    </>
  );
}

export function Connections({
  tools,
  onInstallIeum,
  onRefreshTools,
  browser,
  browserActions,
  onIntegrations,
  onOnboarding,
  providers,
  connected,
  hostLabel,
  engineActions,
  onRefresh,
  themePref,
  onTheme,
  onAppearance,
  startScreen,
  onStartScreen,
  brandMotion,
  onBrandMotion,
  notifications,
  onNotifications,
  imageUpload,
  shortcutSettings,
  onPropertyTemplate,
  vault,
  worksDir,
  onOfficeSettings,
  onKnowledge,
}: {
  /** The Obsidian vault line (pkm). */
  vault?: ReactNode;
  /** "새 프로젝트 폴더 위치" (WorksDirRow.tsx). */
  worksDir?: ReactNode;
  onOfficeSettings?: () => void;
  onKnowledge?: () => void;
  tools: DocumentTools | null;
  /** The agent browser (absent from older gateways). */
  browser: AgentBrowserStatus | null;
  browserActions: BrowserActions;
  onIntegrations: () => void;
  onOnboarding: () => void;
  onInstallIeum: () => void;
  onRefreshTools: () => void;
  providers: Partial<Record<Provider, ProviderStatus>>;
  connected: boolean;
  hostLabel: string;
  engineActions: EngineActions;
  onRefresh: () => void;
  themePref: ThemePref;
  onTheme: (pref: ThemePref) => void;
  onAppearance: () => void;
  /** What the app shows when it opens: home, or the last work straight away. */
  startScreen: "home" | "last";
  onStartScreen: (next: "home" | "last") => void;
  /** The logo's short entrance on home. */
  brandMotion: boolean;
  onBrandMotion: (next: boolean) => void;
  /** OS notifications while the window is behind or in the tray. */
  notifications: boolean;
  onNotifications: (next: boolean) => void;
  /** Where pictures pasted into documents go (ImageUploadSheet.tsx). */
  imageUpload?: ReactNode;
  /** ⋯ › 단축키 (ShortcutSettings). */
  shortcutSettings?: ReactNode;
  /** ⋯ › 프로젝트 속성 템플릿… (the same dialog as the project page's "템플릿…"). */
  onPropertyTemplate?: () => void;
}) {
  return (
    <div className="connections">
      <div className="menu-label">연결 · {hostLabel}</div>
      {!connected ? <div className="notice notice-error compact">앱 내부 연결이 끊겼습니다. 다시 연결하는 중…</div> : null}
      {(["claude", "codex"] as const).map((provider) => {
        const status = providers[provider];
        return (
          <div key={provider} className="connection">
            <EngineCard provider={provider} status={status} actions={engineActions}>
              {status?.account ? (
                <div className="connection-meta">
                  {status.account}
                  {status.plan ? ` · ${status.plan}` : ""}
                </div>
              ) : null}
              {status?.usage.length ? (
                status.usage.map((window) => (
                  <div key={window.label} className="connection-meta">
                    {usageText(window)}
                  </div>
                ))
              ) : status?.loggedIn ? (
                <div className="connection-meta muted">사용량 확인 불가 (첫 요청 후 표시)</div>
              ) : null}
            </EngineCard>
          </div>
        );
      })}
      <button type="button" className="text-button" onClick={onRefresh}>
        상태 새로 고침
      </button>
      <ToolsSection tools={tools} onInstallIeum={onInstallIeum} onRefreshTools={onRefreshTools} />
      {onOfficeSettings && <button type="button" className="text-button" onClick={onOfficeSettings}>문서 AI 설정…</button>}
      {onKnowledge && <button type="button" className="text-button" onClick={onKnowledge}>지식베이스…</button>}
      <BrowserSection status={browser} actions={browserActions} />
      {vault}
      {worksDir}
      <button type="button" className="text-button" onClick={onIntegrations}>
        MCP·스킬 연동 · Claude와 Codex 나란히…
      </button>
      <button type="button" className="text-button" onClick={onOnboarding}>
        처음 안내 다시 보기
      </button>
      {imageUpload}
      <div className="menu-divider" />
      <div className="menu-label">화면</div>
      <div className="segmented theme-choice" role="radiogroup" aria-label="화면">
        {(["system", "light", "dark"] as const).map((pref) => (
          <button key={pref} type="button" role="radio" aria-checked={themePref === pref} className={themePref === pref ? "active" : ""} onClick={() => onTheme(pref)}>
            {THEME_LABEL[pref]}
          </button>
        ))}
      </div>
      <button type="button" className="text-button" onClick={onAppearance}>
        외형 설정 · 엔진별 색과 글자…
      </button>
      <div className="menu-label">앱을 열면</div>
      <div className="segmented theme-choice" role="radiogroup" aria-label="앱을 열면">
        {(
          [
            ["home", "홈"],
            ["last", "마지막 작업"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} type="button" role="radio" aria-checked={startScreen === value} className={startScreen === value ? "active" : ""} onClick={() => onStartScreen(value)}>
            {label}
          </button>
        ))}
      </div>
      <label className="check-row switch-row" data-gallery="uiverse:Toggle-switches/zjssun_friendly-sheep-29" data-component="toggle">
        <input type="checkbox" checked={brandMotion} onChange={(event) => onBrandMotion(event.target.checked)} />
        홈 로고 움직임
      </label>
      <label className="check-row switch-row" data-gallery="uiverse:Toggle-switches/zjssun_friendly-sheep-29" data-component="toggle" title="창이 뒤에 있거나 트레이에 있을 때: 답이 오면, 확인이 필요하면, 실패하면">
        <input type="checkbox" checked={notifications} onChange={(event) => onNotifications(event.target.checked)} />
        끝나면 알림(OS)
      </label>
      {onPropertyTemplate ? (
        <>
          <div className="menu-label">프로젝트</div>
          <button type="button" className="text-button" onClick={onPropertyTemplate}>
            프로젝트 속성 템플릿…
          </button>
        </>
      ) : null}
      {shortcutSettings ? (
        <>
          <div className="menu-label">단축키</div>
          {shortcutSettings}
        </>
      ) : null}
    </div>
  );
}
