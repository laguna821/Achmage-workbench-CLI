import { useState, type ReactNode } from "react";
import { PROVIDER_LABEL, type EngineOrigin, type Provider, type ProviderStatus, type UsageWindow } from "@workbench/contracts";
import { resetIn } from "../format.ts";
import { EngineMark } from "./EngineMark.tsx";
import { PathDetail, SettingsRow } from "./SettingsSheet.tsx";
import "../styles/setup.css";

// One engine as the first run and 설정 › AI 엔진 show it: a row with the engine's mark, its state
// word and the one next step (설치, 로그인) at the end; under it only what the person needs now
// (progress, the browser login's code). Where it was found is said in plain words; the file path
// itself waits behind 경로 보기 (j5). No command is ever shown to type.

export type EngineActions = {
  install: (provider: Provider) => void;
  login: (provider: Provider) => void;
  /** Resolves when the engine took the code; rejects with the reason to show. */
  loginCode: (provider: Provider, code: string) => Promise<void>;
  cancelLogin: (provider: Provider) => void;
  /** 로그아웃 through the engine's own logout (설정 › AI 엔진); resolves when it is done. */
  logout?: (provider: Provider) => Promise<void>;
  /** "로그인 상태 확인": the engine asked again (its status is unknown while it is idle). */
  checkLogin?: (provider: Provider) => void;
  openUrl: (url: string) => void;
  copy: (text: string) => void;
};

/** Where the engine was found, said for a teacher (the contracts' labels are a developer's). */
const ORIGIN_WORDS: Record<EngineOrigin, string> = {
  override: "직접 지정한 위치에서 찾았습니다",
  path: "이 컴퓨터에 설치되어 있습니다",
  shell: "이 컴퓨터에 설치되어 있습니다",
  npm: "이 컴퓨터에 설치되어 있습니다",
  native: "Claude Code 설치 프로그램으로 설치되어 있습니다",
  standalone: "Codex 설치 프로그램으로 설치되어 있습니다",
  homebrew: "Homebrew로 설치되어 있습니다",
  app: "다른 데스크톱 앱에 들어 있는 것을 씁니다",
  editor: "편집기 확장에 들어 있는 것을 씁니다",
  managed: "이 앱이 설치했습니다",
  sdk: "앱에 들어 있는 것을 씁니다",
};

export const capital = (plan: string) => plan ? plan[0]!.toUpperCase() + plan.slice(1) : plan;

/** The short state next to the engine's name. */
export function engineState(status: ProviderStatus | undefined): { text: string; tone: "" | "ok" | "warn" } {
  if (!status) return { text: "확인 중", tone: "" };
  if (status.install?.state === "installing") return { text: "설치 중", tone: "" };
  if (!status.installed) return { text: "이 컴퓨터에 없음", tone: "warn" };
  if (status.login?.state === "waiting") return { text: "로그인 기다리는 중", tone: "" };
  if (status.loggedIn === null) return { text: "확인 중", tone: "" };
  if (!status.loggedIn) return { text: "로그인 필요", tone: "warn" };
  if (status.loginMethod === "metered") return { text: "쓴 만큼 요금", tone: "warn" };
  if (status.loginMethod === "subscription") return { text: `구독으로 연결됨${status.plan ? ` (${capital(status.plan)})` : ""}`, tone: "ok" };
  return { text: "로그인됨", tone: "ok" };
}

/** "5시간 동안 35% 사용, 3시간 뒤 초기화" — one usage window, without middle dots. */
export function usageWords(window: UsageWindow): string {
  const used = window.usedPercent === null ? "사용량 확인 불가" : `${Math.round(window.usedPercent)}% 사용`;
  const reset = resetIn(window.resetsAt);
  return `${window.label} ${used}${reset ? `, ${reset}` : ""}`;
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
      <div className="setup-hint">{login.message ?? "브라우저에서 로그인을 마치면 저절로 연결됩니다."}</div>
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

/**
 * One engine as a settings row. `children` adds lines under the row (the account, usage) — the
 * settings section gives them; the first run does not.
 */
export function EngineCard({ provider, status, actions, children, manage = false }: {
  provider: Provider; status: ProviderStatus | undefined; actions: EngineActions; children?: ReactNode;
  /** 설정 › AI 엔진 (0.5.6 round 2): signed in, 다른 계정으로 다시 로그인 and 로그아웃 (the first run keeps only 로그인). */
  manage?: boolean;
}) {
  const name = PROVIDER_LABEL[provider];
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const state = engineState(status);
  const install = status?.install ?? null;
  const login = status?.login ?? null;
  const installing = install?.state === "installing";
  const canLogin = Boolean(status?.installed && !installing && login?.state !== "waiting" && status.loggedIn === false);
  // Signed in (settings): the same two keys for both engines; unknown (an idle engine): ask it.
  const signedIn = Boolean(manage && status?.installed && !installing && login?.state !== "waiting" && status.loggedIn === true);
  const unknown = Boolean(status?.installed && !installing && login?.state !== "waiting" && status.loggedIn === null && actions.checkLogin);
  const logout = async () => {
    if (!actions.logout) return;
    setLoggingOut(true);
    try { await actions.logout(provider); setConfirmingLogout(false); } finally { setLoggingOut(false); }
  };
  const missing = Boolean(status && !status.installed && !installing);
  const hint = !status ? "이 컴퓨터에서 찾는 중입니다."
    : installing ? install?.message ?? "설치하는 중입니다."
    : missing ? (status.canInstall ? `이 컴퓨터에서 ${name}를 찾지 못했습니다. 설치는 이 사용자의 앱 폴더에 하며 관리자 권한은 필요 없습니다.` : `이 설치본으로는 ${name}를 설치할 수 없습니다. 앱을 다시 설치해 주세요.`)
    : status.binarySource === "bundled" ? "설치된 Claude Code가 없어 앱에 들어 있는 것을 씁니다."
    // Ready: where and which version are behind 찾은 위치 보기; the row says only that it is here (+ the plan).
    : status.installed ? `이 컴퓨터에서 찾았습니다.${status.loggedIn && status.loginMethod === "subscription" && status.plan ? ` ${capital(status.plan)} 구독으로 바로 쓸 수 있습니다.` : ""}` : null;
  const found = status?.installed ? [status.origin ? `${ORIGIN_WORDS[status.origin]}${status.version ? ` (판 ${status.version})` : ""}.` : status.version ? `판 ${status.version}` : "", status.binary ?? ""].filter(Boolean).join("\n") : "";
  const control = missing && status!.canInstall ? (
    <button type="button" className="button small primary" onClick={() => actions.install(provider)}>
      {install?.state === "failed" ? "다시 설치" : `${name} 설치`}
    </button>
  ) : canLogin ? (
    <button type="button" className="button small primary" onClick={() => actions.login(provider)}>
      {name} 로그인
    </button>
  ) : unknown ? (
    <button type="button" className="button small" onClick={() => actions.checkLogin!(provider)}>
      로그인 상태 확인
    </button>
  ) : status?.binarySource === "managed" && status.canInstall && !installing ? (
    <button type="button" className="button small setup-update" onClick={() => actions.install(provider)}>
      최신판으로 업데이트
    </button>
  ) : null;
  return (
    <div className="setup-engine" data-provider={provider}>
      <SettingsRow
        mark={<EngineMark provider={provider} size={16} />}
        label={name}
        state={state}
        hint={hint}
        control={control}
        detail={<>
          {children}
          {installing ? (
            <div className="setup-progress" role="progressbar" aria-label={`${name} 설치`} aria-valuenow={install?.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
              <span className={install?.percent === null ? "indeterminate" : ""} style={{ width: `${install?.percent ?? 30}%` }} />
            </div>
          ) : null}
          {missing && install?.state === "failed" ? <div className="setup-hint warn">{install.message}</div> : null}
          {install?.state === "done" && status?.installed && !status.loggedIn ? <div className="setup-hint ok">{install.message}</div> : null}
          {status?.installed && !installing && login?.state === "waiting" ? <LoginWaiting provider={provider} status={status} actions={actions} /> : null}
          {canLogin ? <div className="setup-hint">{login?.state === "failed" && login.message ? `${login.message} ` : ""}브라우저가 열립니다. 로그인을 마치면 이 화면이 저절로 바뀝니다.</div> : null}
          {status?.loginMethod === "metered" ? <div className="setup-hint warn">구독이 아니라 쓴 만큼 요금이 나가는 로그인입니다. 구독으로 쓰려면 구독 계정으로 다시 로그인하세요.
            {status.installed && !installing && login?.state !== "waiting" ? <> <button type="button" className="text-button" onClick={() => actions.login(provider)}>구독 계정으로 다시 로그인</button></> : null}
          </div> : null}
          {signedIn ? (
            <div className="setup-account-keys">
              {status!.loginMethod === "metered" ? null : <button type="button" className="text-button" onClick={() => actions.login(provider)}>다른 계정으로 다시 로그인</button>}
              {actions.logout ? <button type="button" className="text-button" aria-expanded={confirmingLogout} onClick={() => setConfirmingLogout(!confirmingLogout)}>로그아웃</button> : null}
            </div>
          ) : null}
          {signedIn && confirmingLogout ? (
            <div className="setup-hint setup-logout-confirm" role="group" aria-label={`${name} 로그아웃 확인`}>
              {`이 컴퓨터의 ${name} 로그인을 지웁니다${provider === "claude" ? "(터미널에서 쓰는 Claude Code도 함께 로그아웃됩니다)" : "(터미널에서 쓰는 Codex도 함께 로그아웃됩니다)"}. 진행 중인 ${name} 대화는 중간에 멈출 수 있으니 답이 끝난 뒤에 하세요. `}
              <button type="button" className="button small danger" disabled={loggingOut} aria-busy={loggingOut || undefined} onClick={() => void logout()}>로그아웃</button>
              {" "}<button type="button" className="text-button" onClick={() => setConfirmingLogout(false)}>취소</button>
            </div>
          ) : null}
          {status?.billingVars.length ? <div className="setup-hint">요금이 따로 나가는 키 설정은 엔진에 넘기지 않습니다. 구독 로그인으로 실행합니다.<PathDetail value={status.billingVars.join(", ")} label="자세히" /></div> : null}
          {status?.error && status.installed && !status.loggedIn && login?.state !== "waiting" ? <div className="setup-hint warn">{status.error}</div> : null}
          {status?.installed && found ? <PathDetail value={found} label="찾은 위치 보기" /> : null}
        </>}
      />
    </div>
  );
}
