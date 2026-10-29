import type { ReactNode } from "react";
import { PROVIDER_LABEL, type AgentBrowserStatus, type DocumentTools, type Provider, type ProviderStatus } from "@workbench/contracts";
import { usageText } from "../format.ts";
import type { ThemePref } from "../theme.ts";
import { BrowserInstall, BrowserLogin, type BrowserActions } from "./BrowserPill.tsx";

const THEME_LABEL: Record<ThemePref, string> = { system: "시스템", light: "라이트", dark: "다크" };

/** Engine login and usage state. Shows only values the engines report; unknown stays unknown. */
/** Document engines: what each one does here and whether it is on this computer. */
function ToolsSection({ tools, onInstallIeum, onRefreshTools }: { tools: DocumentTools | null; onInstallIeum: () => void; onRefreshTools: () => void }) {
  if (!tools) return null;
  const rows = [
    { key: "kordoc", name: "kordoc", role: "한글(HWPX) 만들기·글 보기·쪽 미리보기", status: tools.kordoc },
    { key: "hop", name: "Achmage HOP", role: "한글 문서를 사람이 편집(HOP로 열기 → 저장하면 새 판)", status: tools.hop },
    { key: "ieumoffice", name: "이음오피스", role: "워드·PPT·엑셀 미리보기·글 보기·AI 수정", status: tools.ieumoffice },
  ] as const;
  return (
    <>
      <div className="menu-divider" />
      <div className="menu-label">문서 도구</div>
      {rows.map((row) => (
        <div key={row.key} className="connection">
          <div className="connection-head">
            <span className="connection-name">{row.name}</span>
            <span className={`connection-state ${row.status.available ? "ok" : "warn"}`}>
              {row.status.busy ? "설치 중…" : row.status.available ? (row.status.version ? `사용 가능 · ${row.status.version}` : "사용 가능") : "없음"}
            </span>
          </div>
          <div className="connection-meta muted">{row.role}</div>
          {row.status.message ? <div className="connection-meta">{row.status.message}</div> : null}
          {row.key === "ieumoffice" && !row.status.busy ? (
            <button type="button" className="button small" onClick={onInstallIeum} title="GitHub 배포판을 받아 체크섬을 확인한 뒤 ~/.local/opt/ieumoffice에 풉니다">
              {row.status.available ? "최신판으로 업데이트" : "이음오피스 설치"}
            </button>
          ) : null}
        </div>
      ))}
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
    install.state === "ready" ? `준비됨${install.browserVersion ? ` · Chromium ${install.browserVersion.split(".")[0]}` : ""}` : install.state === "installing" ? "설치 중…" : install.state === "error" ? "설치 실패" : "없음";
  return (
    <>
      <div className="menu-divider" />
      <div className="connection browser-connection">
        <div className="connection-head">
          <span className="connection-name">에이전트 브라우저</span>
          <span className={`connection-state ${install.state === "ready" ? "ok" : "warn"}`}>{state}</span>
        </div>
        <div className="connection-meta muted">Claude·Codex 세션이 Playwright CLI로 화면에 보이는 Chromium 창을 씁니다(입력창 아래 '브라우저').</div>
        <BrowserInstall status={status} actions={actions} />
        {install.state === "ready" ? (
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
  onLogin,
  onRefresh,
  loginMessage,
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
  vault,
}: {
  /** The Obsidian vault line (pkm). */
  vault?: ReactNode;
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
  onLogin: (provider: Provider) => void;
  onRefresh: () => void;
  loginMessage: string | null;
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
}) {
  return (
    <div className="connections">
      <div className="menu-label">연결 · {hostLabel}</div>
      {!connected ? <div className="notice notice-error compact">앱 내부 연결이 끊겼습니다. 다시 연결하는 중…</div> : null}
      {(["claude", "codex"] as const).map((provider) => {
        const status = providers[provider];
        const state = !status
          ? "확인 중"
          : !status.installed
            ? "설치되지 않음"
            : status.loggedIn === null
              ? "확인 중"
              : !status.loggedIn
                ? "로그인 필요"
                : status.loginMethod === "subscription"
                  ? "구독 연결됨"
                  : status.loginMethod === "metered"
                    ? "종량제 로그인"
                    : "로그인됨";
        const tone = status?.loggedIn && status.loginMethod !== "metered" ? "ok" : status?.loggedIn === false || status?.loginMethod === "metered" ? "warn" : "";
        return (
          <div key={provider} className="connection">
            <div className="connection-head">
              <span className="connection-name">{PROVIDER_LABEL[provider]}</span>
              <span className={`connection-state ${tone}`}>{state}</span>
            </div>
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
            {status?.loginMethod === "metered" ? (
              <div className="connection-meta warn">API 키나 클라우드 경로로 로그인되어 있어 쓴 만큼 요금이 나갑니다. 구독으로 쓰려면 구독 계정으로 다시 로그인하세요.</div>
            ) : null}
            {status?.billingVars.length ? (
              <div className="connection-meta muted">
                {status.billingVars.join(", ")} 환경변수는 엔진에 넘기지 않습니다(구독 로그인으로 실행).
              </div>
            ) : null}
            {status?.binarySource === "bundled" ? (
              <div className="connection-meta muted">설치된 Claude Code가 없어 SDK에 들어 있는 엔진으로 실행합니다.</div>
            ) : null}
            {status?.version ? <div className="connection-meta muted mono">{status.version}</div> : null}
            {status?.error && !status.loggedIn ? <div className="connection-meta warn">{status.error}</div> : null}
            {status?.installed && status.loggedIn === false ? (
              <button type="button" className="button small" onClick={() => onLogin(provider)}>
                {PROVIDER_LABEL[provider]} 로그인
              </button>
            ) : null}
          </div>
        );
      })}
      {loginMessage ? <div className="connection-meta">{loginMessage}</div> : null}
      <button type="button" className="text-button" onClick={onRefresh}>
        상태 새로 고침
      </button>
      <ToolsSection tools={tools} onInstallIeum={onInstallIeum} onRefreshTools={onRefreshTools} />
      <BrowserSection status={browser} actions={browserActions} />
      {vault}
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
    </div>
  );
}
