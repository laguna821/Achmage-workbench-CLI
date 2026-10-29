import { useState, type ReactNode } from "react";
import { ENGINE_ORIGIN_LABEL, PROVIDER_LABEL, type Provider, type ProviderStatus } from "@workbench/contracts";
import "../styles/setup.css";

// One engine as the first-run guide and the connection panel show it: where it was found, a
// one-click install when it is missing, and a one-click login through the engine's own login in
// the browser (with the address and, for Claude Code, a box for the page's code as a fallback).
// No command is ever shown to type.

export type EngineActions = {
  install: (provider: Provider) => void;
  login: (provider: Provider) => void;
  /** Resolves when the engine took the code; rejects with the reason to show. */
  loginCode: (provider: Provider, code: string) => Promise<void>;
  cancelLogin: (provider: Provider) => void;
  openUrl: (url: string) => void;
  copy: (text: string) => void;
};

/** The short state next to the engine's name. */
export function engineState(status: ProviderStatus | undefined): { text: string; tone: "" | "ok" | "warn" } {
  if (!status) return { text: "확인 중…", tone: "" };
  if (status.install?.state === "installing") return { text: "설치 중…", tone: "" };
  if (!status.installed) return { text: "아직 없음", tone: "warn" };
  if (status.login?.state === "waiting") return { text: "로그인 기다리는 중", tone: "" };
  if (status.loggedIn === null) return { text: "확인 중…", tone: "" };
  if (!status.loggedIn) return { text: "로그인 필요", tone: "warn" };
  if (status.loginMethod === "metered") return { text: "종량제 로그인", tone: "warn" };
  if (status.loginMethod === "subscription") return { text: `구독 연결됨${status.plan ? ` · ${status.plan}` : ""}`, tone: "ok" };
  return { text: "로그인됨", tone: "ok" };
}

function CodeBox({ provider, actions }: { provider: Provider; actions: EngineActions }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="setup-code"
      onSubmit={(event) => {
        event.preventDefault();
        if (!code.trim() || busy) return;
        setBusy(true);
        setError(null);
        actions
          .loginCode(provider, code)
          .then(() => setCode(""))
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setBusy(false));
      }}
    >
      <label className="setup-hint" htmlFor={`setup-code-${provider}`}>
        로그인 페이지에 코드가 나왔다면 여기에 붙여 넣으세요.
      </label>
      <div className="setup-code-row">
        <input id={`setup-code-${provider}`} value={code} onChange={(event) => setCode(event.target.value)} placeholder="코드" autoComplete="off" spellCheck={false} />
        <button type="submit" className="button small" disabled={!code.trim() || busy}>
          넣기
        </button>
      </div>
      {error ? <div className="setup-hint warn">{error}</div> : null}
    </form>
  );
}

/** The login the engine is waiting on: what to do in the browser, and the fallbacks. */
function LoginWaiting({ provider, status, actions }: { provider: Provider; status: ProviderStatus; actions: EngineActions }) {
  const login = status.login!;
  return (
    <div className="setup-login" role="status">
      <div className="setup-hint">{login.message ?? "브라우저에서 로그인을 마치면 자동으로 연결됩니다."}</div>
      {login.userCode ? (
        <div className="setup-user-code">
          <span>입력할 코드</span>
          <strong>{login.userCode}</strong>
          <button type="button" className="text-button" onClick={() => actions.copy(login.userCode!)}>
            복사
          </button>
        </div>
      ) : null}
      {login.url ? (
        <div className="setup-url">
          <span className="setup-hint">브라우저가 열리지 않았다면</span>
          <button type="button" className="button small" onClick={() => actions.openUrl(login.url!)}>
            로그인 페이지 열기
          </button>
          <button type="button" className="text-button" onClick={() => actions.copy(login.url!)}>
            주소 복사
          </button>
        </div>
      ) : null}
      {login.acceptsCode ? <CodeBox provider={provider} actions={actions} /> : null}
      <button type="button" className="text-button setup-cancel" onClick={() => actions.cancelLogin(provider)}>
        로그인 그만두기
      </button>
    </div>
  );
}

export function EngineCard({ provider, status, actions, children }: { provider: Provider; status: ProviderStatus | undefined; actions: EngineActions; children?: ReactNode }) {
  const name = PROVIDER_LABEL[provider];
  const state = engineState(status);
  const install = status?.install ?? null;
  const login = status?.login ?? null;
  const installing = install?.state === "installing";
  return (
    <div className="setup-engine" data-provider={provider}>
      <div className="connection-head">
        <strong className="connection-name">{name}</strong>
        <span className={`connection-state ${state.tone}`}>{state.text}</span>
      </div>
      {children}
      {status?.installed && status.binary ? (
        <div className="setup-found">
          <span>
            {status.origin ? ENGINE_ORIGIN_LABEL[status.origin] : "찾음"}
            {status.version ? ` · ${status.version}` : ""}
          </span>
          <code title={status.binary}>{status.binary}</code>
        </div>
      ) : null}
      {installing ? (
        <div className="setup-progress-block">
          <div className="setup-hint">{install?.message ?? "설치하는 중…"}</div>
          <div className="setup-progress" role="progressbar" aria-label={`${name} 설치`} aria-valuenow={install?.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <span className={install?.percent === null ? "indeterminate" : ""} style={{ width: `${install?.percent ?? 30}%` }} />
          </div>
        </div>
      ) : null}
      {status && !status.installed && !installing ? (
        status.canInstall ? (
          <>
            <div className="setup-hint">
              이 컴퓨터에서 {name}를 찾지 못했습니다. 누르면 이 사용자의 앱 폴더에 설치합니다. 관리자 권한은 필요 없습니다.
            </div>
            {install?.state === "failed" ? <div className="setup-hint warn">{install.message}</div> : null}
            <button type="button" className="button small primary" onClick={() => actions.install(provider)}>
              {install?.state === "failed" ? "다시 설치" : `${name} 설치`}
            </button>
          </>
        ) : (
          <div className="setup-hint warn">이 설치본으로는 {name}를 설치할 수 없습니다. 앱을 다시 설치해 주세요.</div>
        )
      ) : null}
      {install?.state === "done" && status?.installed && !status.loggedIn ? <div className="setup-hint ok">{install.message}</div> : null}
      {status?.installed && !installing && login?.state === "waiting" ? <LoginWaiting provider={provider} status={status} actions={actions} /> : null}
      {status?.installed && !installing && login?.state !== "waiting" && status.loggedIn === false ? (
        <>
          {login?.state === "failed" ? <div className="setup-hint warn">{login.message}</div> : null}
          <button type="button" className="button small primary" onClick={() => actions.login(provider)}>
            {name} 로그인
          </button>
          <div className="setup-hint">브라우저가 열립니다. 로그인을 마치면 이 창이 저절로 바뀝니다.</div>
        </>
      ) : null}
      {status?.loginMethod === "metered" ? <div className="setup-hint warn">구독이 아니라 쓴 만큼 요금이 나가는 로그인(API 키 등)입니다. 구독으로 쓰려면 구독 계정으로 다시 로그인하세요.</div> : null}
      {status?.billingVars.length ? <div className="setup-hint">{status.billingVars.join(", ")} 환경 변수는 엔진에 넘기지 않습니다(구독 로그인으로 실행).</div> : null}
      {status?.binarySource === "bundled" ? <div className="setup-hint">설치된 Claude Code가 없어 SDK에 들어 있는 엔진으로 실행합니다.</div> : null}
      {status?.binarySource === "managed" && status.canInstall && !installing ? (
        <button type="button" className="text-button setup-update" onClick={() => actions.install(provider)}>
          최신판으로 업데이트
        </button>
      ) : null}
      {status?.error && status.installed && !status.loggedIn && login?.state !== "waiting" ? <div className="setup-hint warn">{status.error}</div> : null}
    </div>
  );
}
