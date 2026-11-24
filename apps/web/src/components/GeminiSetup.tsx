import type { ProviderStatus } from "@workbench/contracts";
import { EngineMark } from "./EngineMark.tsx";
import { PathDetail, SettingsRow, SettingsSwitch } from "./SettingsSheet.tsx";

// 설정 › AI 엔진 › Gemini (0.5.6): Workbench as an ACP client of the person's installed Antigravity CLI.
// Study § G (binding): say what it is (rule 11); agy signs in by itself in a terminal tab the person sees
// (rule 3); install only by running Google's installer in a visible terminal (rule 9). Subscription login only
// (the owner, 2026-11-21): one way in — 'Google 계정으로 로그인', agy's own sign-in, a personal or a company
// Google account (agy decides) — always behind the explicit opt-in. No API key, no Cloud project.

export type GeminiActions = {
  /** Save the opt-in; the gateway answers with the new status. */
  settings(patch: { googleOptIn?: boolean }): void;
  /** 설치 / 로그인: a terminal tab running Google's installer or `agy acp --login`. */
  terminal(action: "install" | "login"): void;
  refresh(): void;
  openUrl(url: string): void;
};

/** Rule 11, word for word. */
export const GEMINI_WHAT_IT_IS = "Gemini는 이 컴퓨터에 설치된 Google 공식 Antigravity CLI를 사용합니다. Google이 보증하는 연동은 아닙니다. 개인 계정 사용 조건은 Google 약관을 따릅니다.";
/**
 * The risk, Google's texts as they stand, and (study § H / H+) the DeepMind staff's public statement as a fact —
 * no person named, no post linked; Google's FAQ and terms are linked beside it.
 */
export const GEMINI_GOOGLE_WARNING = "Google 약관(6조)과 FAQ는 다른 회사의 앱으로 개인 계정에 접속하는 것을 금지한다고 적고 있고, 어기면 계정이 정지될 수 있다고 적고 있습니다. Google DeepMind 직원들이 2026-11-21~22에 Antigravity ACP 서버를 그대로 쓰는 앱은 괜찮다며 약관을 고쳐 보겠다고 밝혔지만, 공식 약관과 FAQ는 아직 바뀌지 않았습니다. Workbench는 agy를 그대로 실행하고, 로그인은 agy가 직접 하며, 사람이 보내는 요청에만 씁니다. 그래도 위험은 계정 주인이 집니다.";
export const GEMINI_PERSON_ONLY_HINT = "Gemini는 사람이 직접 보내는 대화에만 씁니다. 예약, 자동화, 다른 대화가 넘기는 일, 문서 AI에는 쓰지 않습니다.";
/** One way to sign in: agy's own, with whatever Google account the person has. */
export const GEMINI_ONE_LOGIN = "구독 로그인만 씁니다. 개인 계정이든 회사 계정이든 agy의 로그인 창에서 고르며, API 키는 쓰지 않습니다.";
/** Google blocked the account (agy said so; study § H). */
export const GEMINI_SUSPENDED_LINE = "Google이 이 계정의 Antigravity 사용을 막았습니다.";
/** agy works from 1.5.2; 1.5.12 or later is recommended (it updates itself: no Workbench updater). */
export const GEMINI_RECOMMEND = "Antigravity CLI를 1.5.12 이상으로 올리면 연결이 더 안정적입니다. 터미널에서 agy를 한 번 실행하면 스스로 업데이트합니다.";
/** Why the access picker has no 전체 접근 for Gemini (study § G rule 5). */
export const GEMINI_NO_FULL = "Gemini에서는 전체 접근을 쓰지 않습니다. 확인 요청에는 늘 직접 답합니다.";

export function geminiState(status: ProviderStatus | undefined): { text: string; tone: "" | "ok" | "warn" } {
  const gemini = status?.gemini;
  if (!status) return { text: "확인 중", tone: "" };
  if (!status.installed) return { text: "이 컴퓨터에 없음", tone: "warn" };
  if (gemini?.versionOk === false) return { text: "업데이트 필요", tone: "warn" };
  if (gemini?.suspended) return { text: "사용 막힘", tone: "warn" };
  if (!gemini?.googleOptIn) return { text: "동의 필요", tone: "warn" };
  if (status.loggedIn === false) return { text: "로그인 필요", tone: "warn" };
  if (status.loggedIn === null) return { text: "첫 대화에서 확인", tone: "" };
  return { text: "로그인됨", tone: "ok" };
}

export function GeminiCard({ status, actions }: { status: ProviderStatus | undefined; actions: GeminiActions }) {
  const gemini = status?.gemini ?? null;
  const state = geminiState(status);
  const installed = Boolean(status?.installed);
  const old = gemini?.versionOk === false;
  const optedOut = !gemini?.googleOptIn;
  const blocked = gemini?.suspended ?? null;
  const needsLogin = installed && !old && !optedOut && !blocked && status?.loggedIn === false;
  // The engine rows' pattern (설정 › AI 엔진, 0.5.6 round 2): 로그인 when signed out, 로그인 상태 확인 when unknown,
  // 다른 계정으로 다시 로그인 when signed in (agy's terminal sign-in again). No 로그아웃: agy documents no logout
  // command (only `/logout` inside its own interactive session) and its ACP offers none. 다시 확인 looks for agy
  // again after Google's installer ran in its terminal.
  const find = <button type="button" className="button small" onClick={actions.refresh}>다시 확인</button>;
  const check = <button type="button" className="button small" onClick={actions.refresh}>로그인 상태 확인</button>;
  const signedIn = installed && !old && !optedOut && status?.loggedIn === true;
  const control = !installed ? <>{find}<button type="button" className="button small primary" onClick={() => actions.terminal("install")}>Antigravity CLI 설치</button></>
    : old ? find
    : optedOut ? null
    : blocked ? check
    : needsLogin ? <>{check}<button type="button" className="button small primary" onClick={() => actions.terminal("login")}>Google 계정으로 로그인</button></>
    : status?.loggedIn === null ? check
    : null;
  const hint = !status ? "이 컴퓨터에서 찾는 중입니다."
    : !installed ? "이 컴퓨터에서 Antigravity CLI(agy)를 찾지 못했습니다. 설치 단추는 Google 공식 설치 프로그램을 터미널 탭에서 실행합니다. 끝나면 다시 확인을 누르세요."
    : old ? status.error ?? `Antigravity CLI ${gemini?.minVersion ?? "1.5.2"} 이상이 필요합니다. 터미널에서 agy를 한 번 실행하면 스스로 업데이트합니다.`
    : optedOut ? "Gemini를 쓰려면 아래 안내를 읽고 동의해 주세요."
    : blocked ? `${GEMINI_SUSPENDED_LINE} Workbench는 다시 시도하지 않습니다. 이의 제기는 Google에 직접 합니다.`
    : needsLogin ? "로그인 단추는 터미널 탭에서 agy acp --login을 실행합니다. 브라우저나 코드 입력은 agy가 직접 안내합니다. 끝나면 로그인 상태 확인을 누르세요."
    : status.loggedIn ? "이 컴퓨터에서 찾았습니다. Google 계정으로 씁니다."
    : "이 컴퓨터에서 찾았습니다. 로그인 상태는 첫 Gemini 대화에서 확인합니다.";
  return <div className="setup-engine gemini-setup" data-provider="gemini">
    <SettingsRow mark={<EngineMark provider="gemini" size={16} />} label="Gemini" state={state} hint={hint} control={control}
      detail={<>
        <p className="settings-note gemini-what">{GEMINI_WHAT_IT_IS}</p>
        <p className="settings-note">{GEMINI_ONE_LOGIN}</p>
        <div className="gemini-optin" role="group" aria-label="Gemini 사용 동의">
          <p className="setup-hint warn">{GEMINI_GOOGLE_WARNING}</p>
          <p className="setup-hint">
            <button type="button" className="text-button" onClick={() => actions.openUrl(gemini?.links.faq ?? "https://antigravity.google/docs/faq")}>Google FAQ 보기</button>{" "}
            <button type="button" className="text-button" onClick={() => actions.openUrl(gemini?.links.terms ?? "https://antigravity.google/terms")}>Google 약관 보기</button>
          </p>
          <SettingsRow className="gemini-optin-row" label="위 내용을 읽었고 내 Google 계정으로 씁니다" hint={GEMINI_PERSON_ONLY_HINT}
            control={<SettingsSwitch label="위 내용을 읽었고 내 Google 계정으로 씁니다" checked={Boolean(gemini?.googleOptIn)} onChange={(next) => actions.settings({ googleOptIn: next })} />} />
        </div>
        {blocked ? <div className="setup-hint warn" role="status"><p>{GEMINI_SUSPENDED_LINE}</p>{blocked.appeal ? <button type="button" className="text-button" onClick={() => actions.openUrl(blocked.appeal!)}>Google에 이의 제기</button> : null}</div> : null}
        {installed && !old && gemini?.versionRecommended === false ? <p className="setup-hint">{GEMINI_RECOMMEND}</p> : null}
        {status?.account && status.loggedIn ? <p className="settings-note">{status.account}</p> : null}
        {signedIn ? <div className="setup-account-keys">
          <button type="button" className="text-button" onClick={() => actions.terminal("login")}>다른 계정으로 다시 로그인</button>
        </div> : null}
        {status?.loggedIn ? <p className="settings-note">사용 한도(5시간, 주간)는 agy가 Workbench에 알려 주지 않습니다. 대화 창에 /usage를 보내면 agy가 직접 답합니다. 대화가 차지하는 맥락 크기는 대화 아래에 보입니다.</p> : null}
        {gemini?.strippedVars.length ? <div className="setup-hint">API 키, Cloud 프로젝트, ADC 같은 환경 변수는 agy에 넘기지 않습니다(요금이 따로 나가지 않도록).<PathDetail value={gemini.strippedVars.join(", ")} label="자세히" /></div> : null}
        {!installed && gemini ? <PathDetail value={gemini.installCommand} label="설치 명령 보기" /> : null}
        {installed && status ? <PathDetail value={[status.version ? `판 ${status.version}` : "", status.binary ?? ""].filter(Boolean).join("\n")} label="찾은 위치 보기" /> : null}
      </>} />
  </div>;
}
