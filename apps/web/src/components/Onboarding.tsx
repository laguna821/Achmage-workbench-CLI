import { useEffect, useState } from "react";
import { PROVIDER_LABEL, type DocumentTools, type Provider, type ProviderStatus } from "@workbench/contracts";
import { Icon } from "./Icon.tsx";

// First run: what is on this computer and what is missing, in four short steps. The engines are
// found and checked by the gateway (their own status commands); Workbench never asks for a
// password or token. Nothing is installed without a click.

const INSTALL: Record<Provider, { command: string; page: string }> = {
  claude: { command: "curl -fsSL https://claude.ai/install.sh | bash", page: "https://docs.claude.com/en/docs/claude-code/setup" },
  codex: { command: "npm install -g @openai/codex", page: "https://github.com/openai/codex" },
};

function engineState(status: ProviderStatus | undefined) {
  if (!status) return { text: "확인 중…", tone: "" };
  if (!status.installed) return { text: "설치되지 않음", tone: "warn" };
  if (status.loggedIn === null) return { text: "확인 중…", tone: "" };
  if (!status.loggedIn) return { text: "로그인 필요", tone: "warn" };
  if (status.loginMethod === "metered") return { text: "종량제 로그인(API 키 등)", tone: "warn" };
  if (status.loginMethod === "subscription") return { text: `구독 연결됨${status.plan ? ` · ${status.plan}` : ""}`, tone: "ok" };
  return { text: "로그인됨", tone: "ok" };
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="onboarding-command">
      <code>{text}</code>
      <button
        type="button"
        className="link"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "복사됨" : "복사"}
      </button>
    </span>
  );
}

export function Onboarding({
  providers,
  tools,
  onLogin,
  onRefresh,
  onInstallIeum,
  onDone,
}: {
  providers: Partial<Record<Provider, ProviderStatus>>;
  tools: DocumentTools | null;
  onLogin: (provider: Provider) => void;
  onRefresh: () => void;
  onInstallIeum: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const steps = ["환영", "엔진 연결", "문서 도구", "쓰는 법"];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onDone();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  // Re-check when the window comes back (after an install or a login in the browser).
  useEffect(() => {
    const onFocus = () => onRefresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [onRefresh]);

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="처음 안내">
      <div className="onboarding">
        <ol className="onboarding-steps">
          {steps.map((label, index) => (
            <li key={label} className={index === step ? "active" : index < step ? "done" : ""}>
              {label}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <section>
            <h2>Achmage Workbench</h2>
            <p>Claude Code와 Codex를 한 화면에서 씁니다. 이미 이 컴퓨터에 있는 구독을 그대로 씁니다.</p>
            <ul>
              <li>문서는 작업 폴더의 파일 그대로 판(r1, r2…)으로 남습니다.</li>
              <li>AI 수정은 수정안으로 받아 보고 적용합니다. 내가 먼저 고친 문서는 덮어쓰지 않습니다.</li>
              <li>한글·워드·PPT·엑셀·마크다운·디자인 문서를 대화 안에서 보고, @로 붙이고, 새 문서로 만듭니다.</li>
            </ul>
          </section>
        ) : null}

        {step === 1 ? (
          <section>
            <h2>엔진 연결</h2>
            <p className="muted">이 컴퓨터의 Claude Code와 Codex를 찾아 각자의 로그인 상태를 확인했습니다. 비밀번호나 토큰은 묻지도 읽지도 않습니다.</p>
            {(["claude", "codex"] as const).map((provider) => {
              const status = providers[provider];
              const state = engineState(status);
              return (
                <div key={provider} className="onboarding-card">
                  <div className="connection-head">
                    <strong>{PROVIDER_LABEL[provider]}</strong>
                    <span className={`connection-state ${state.tone}`}>{state.text}</span>
                  </div>
                  {status && !status.installed ? (
                    <div className="connection-meta">
                      터미널에서 공식 설치 명령을 실행한 뒤 이 창으로 돌아오세요: <Copyable text={INSTALL[provider].command} />
                    </div>
                  ) : null}
                  {status?.installed && status.loggedIn === false ? (
                    <button type="button" className="button small" onClick={() => onLogin(provider)}>
                      {PROVIDER_LABEL[provider]} 로그인 (브라우저)
                    </button>
                  ) : null}
                  {status?.loginMethod === "metered" ? <div className="connection-meta warn">구독이 아니라 쓴 만큼 요금이 나가는 로그인입니다.</div> : null}
                  {status?.billingVars.length ? (
                    <div className="connection-meta muted">{status.billingVars.join(", ")}는 엔진에 넘기지 않습니다(구독으로 실행).</div>
                  ) : null}
                </div>
              );
            })}
            <p className="onboarding-notice">
              요청과 붙인 문서는 고른 엔진(Anthropic 또는 OpenAI)으로 보내집니다. 학습에 쓰이는지는 각 계정의 설정을 따르고, Workbench는 따로 보내지 않습니다.
            </p>
            <button type="button" className="text-button" onClick={onRefresh}>
              다시 확인
            </button>
          </section>
        ) : null}

        {step === 2 ? (
          <section>
            <h2>문서 도구</h2>
            <p className="muted">형식마다 맞는 도구를 씁니다. 없는 도구는 그 형식만 미리보기·수정이 빠질 뿐 나머지는 그대로 씁니다.</p>
            {tools
              ? (
                  [
                    { key: "kordoc", name: "kordoc", role: "한글(HWPX) 만들기·글 보기·쪽 미리보기", status: tools.kordoc },
                    { key: "hop", name: "Achmage HOP", role: "한글 문서를 사람이 편집", status: tools.hop },
                    { key: "ieumoffice", name: "이음오피스", role: "워드·PPT·엑셀 미리보기·AI 수정", status: tools.ieumoffice },
                  ] as const
                ).map((row) => (
                  <div key={row.key} className="onboarding-card">
                    <div className="connection-head">
                      <strong>{row.name}</strong>
                      <span className={`connection-state ${row.status.available ? "ok" : "warn"}`}>
                        {row.status.busy ? "설치 중…" : row.status.available ? `사용 가능${row.status.version ? ` · ${row.status.version}` : ""}` : "없음"}
                      </span>
                    </div>
                    <div className="connection-meta muted">{row.role}</div>
                    {row.status.message ? <div className="connection-meta">{row.status.message}</div> : null}
                    {row.key === "ieumoffice" && !row.status.available && !row.status.busy ? (
                      <button type="button" className="button small" onClick={onInstallIeum}>
                        이음오피스 설치 (GitHub 배포판, 체크섬 확인)
                      </button>
                    ) : null}
                  </div>
                ))
              : null}
          </section>
        ) : null}

        {step === 3 ? (
          <section>
            <h2>이렇게 씁니다</h2>
            <ul>
              <li>
                입력창에서 <kbd>@</kbd>를 치면 이 작업의 문서가 뜹니다. 붙인 문서마다 <b>읽기 / 고치기</b>를 고릅니다.
              </li>
              <li>
                <Icon name="plus" size={13} /> 버튼으로 결과를 <b>새 문서</b>(한글·워드·PPT·엑셀·마크다운·디자인)로 만들게 합니다.
              </li>
              <li>연 문서는 위쪽 탭에 남습니다. 대화와 문서를 한 번에 오갑니다.</li>
              <li>AI 수정안은 전/후 그림으로 보고 적용합니다. 연결·MCP·스킬은 오른쪽 위 ⋯ 메뉴에 있습니다.</li>
            </ul>
          </section>
        ) : null}

        <div className="onboarding-actions">
          <button type="button" className="text-button" onClick={onDone}>
            건너뛰기
          </button>
          <span className="spacer" />
          {step > 0 ? (
            <button type="button" className="button" onClick={() => setStep(step - 1)}>
              이전
            </button>
          ) : null}
          {step < steps.length - 1 ? (
            <button type="button" className="button primary" onClick={() => setStep(step + 1)}>
              다음
            </button>
          ) : (
            <button type="button" className="button primary" onClick={onDone}>
              시작하기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
