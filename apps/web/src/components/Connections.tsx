import { PROVIDER_LABEL, type Provider, type ProviderStatus } from "@workbench/contracts";
import { usageText } from "../format.ts";
import type { ThemePref } from "../theme.ts";

const THEME_LABEL: Record<ThemePref, string> = { system: "시스템", light: "라이트", dark: "다크" };

/** Engine login and usage state. Shows only values the engines report; unknown stays unknown. */
export function Connections({
  providers,
  connected,
  hostLabel,
  onLogin,
  onRefresh,
  loginMessage,
  themePref,
  onTheme,
}: {
  providers: Partial<Record<Provider, ProviderStatus>>;
  connected: boolean;
  hostLabel: string;
  onLogin: (provider: Provider) => void;
  onRefresh: () => void;
  loginMessage: string | null;
  themePref: ThemePref;
  onTheme: (pref: ThemePref) => void;
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
              : status.loggedIn
                ? "로그인됨"
                : "로그인 필요";
        return (
          <div key={provider} className="connection">
            <div className="connection-head">
              <span className="connection-name">{PROVIDER_LABEL[provider]}</span>
              <span className={`connection-state ${status?.loggedIn ? "ok" : status?.loggedIn === false ? "warn" : ""}`}>{state}</span>
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
      <div className="menu-divider" />
      <div className="menu-label">화면</div>
      <div className="segmented theme-choice" role="radiogroup" aria-label="화면">
        {(["system", "light", "dark"] as const).map((pref) => (
          <button key={pref} type="button" role="radio" aria-checked={themePref === pref} className={themePref === pref ? "active" : ""} onClick={() => onTheme(pref)}>
            {THEME_LABEL[pref]}
          </button>
        ))}
      </div>
    </div>
  );
}
