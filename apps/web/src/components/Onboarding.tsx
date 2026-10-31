import { useEffect, useState } from "react";
import type { DocumentTools, Provider, ProviderStatus, ToolStatus } from "@workbench/contracts";
import { EngineCard, type EngineActions } from "./EngineSetup.tsx";
import { Icon } from "./Icon.tsx";

// First run: what is on this computer and what is missing, in four short steps. The engines are
// found and checked by the gateway (their own status commands); a missing one installs and each
// logs in with one click. Workbench never asks for a password or token, and shows no command to
// type. The document tools ship with the app.

/** A document tool's state: shipped with the app, found on this computer, or not here. */
export function toolState(status: ToolStatus) {
  if (status.busy) return { text: "설치 중…", tone: "" };
  if (status.bundled) return { text: `앱에 포함${status.version ? ` · ${status.version}` : ""}`, tone: "ok" };
  if (status.available) return { text: `사용 가능${status.version ? ` · ${status.version}` : ""}`, tone: "ok" };
  return { text: "없음", tone: "warn" };
}

export function Onboarding({
  providers,
  tools,
  engineActions,
  onRefresh,
  onInstallIeum,
  onDone,
}: {
  providers: Partial<Record<Provider, ProviderStatus>>;
  tools: DocumentTools | null;
  engineActions: EngineActions;
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
            <p className="muted">이 컴퓨터의 Claude Code와 Codex를 찾아 각자의 로그인 상태를 확인했습니다. 없으면 눌러서 설치하고, 로그인도 눌러서 합니다. 비밀번호나 토큰은 묻지도 읽지도 않습니다.</p>
            {(["claude", "codex"] as const).map((provider) => (
              <div key={provider} className="onboarding-card">
                <EngineCard provider={provider} status={providers[provider]} actions={engineActions} />
              </div>
            ))}
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
            <p className="muted">형식마다 맞는 도구를 씁니다. 한글·워드·PPT·엑셀·PDF 도구는 앱에 들어 있어 따로 설치하지 않습니다.</p>
            {tools
              ? (
                  [
                    { key: "kordoc", name: "hallym-kordoc 스킬", role: "Markdown·양식으로 HWPX 만들기 · 사용자 설치 스킬 우선", status: tools.kordoc },
                    { key: "ieumoffice", name: "내장 이음오피스 편집기", role: "워드·PPT·엑셀 편집·저장·문서별 AI", status: tools.ieumoffice },
                    ...(tools.ieumApp ? [{ key: "ieumApp", name: "이음오피스 앱 연결 (선택)", role: "앱으로 열기 → 같은 파일 편집·저장 → Workbench에서 이어서 작업", status: tools.ieumApp } as const] : []),
                    ...(tools.hwp ? [{ key: "hwp", name: "이음 한글", role: "앱 안에서 HWP·HWPX 편집·저장·출력", status: tools.hwp } as const] : []),
                    ...(tools.pdf ? [{ key: "pdf", name: "이음 PDF", role: "앱 안에서 PDF 편집·쪽 정리·사본 저장", status: tools.pdf } as const] : []),
                  ] as const
                ).map((row) => {
                  const state = toolState(row.status);
                  return (
                    <div key={row.key} className="onboarding-card">
                      <div className="connection-head">
                        <strong>{row.name}</strong>
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
                })
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
