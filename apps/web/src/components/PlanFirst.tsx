import Markdown from "react-markdown";
import { StateWord } from "./StateMark.tsx";
import { ROW_STATES } from "../row-state.ts";
import { REMARK_BASE } from "../markdown/plugins.ts";
import { PROVIDER_LABEL, type Provider, type TranscriptItem } from "@workbench/contracts";
import { Icon } from "./Icon.tsx";
import { EngineMark } from "./EngineMark.tsx";
import "../styles/plan.css";

type Approval = Extract<TranscriptItem, { kind: "approval" }>;

/**
 * "계획 먼저" in the input's left slot: the next request only plans (the engine reads, changes
 * nothing) and the plan waits for the go-ahead. It stays on until a plan is accepted.
 */
export function PlanToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`plain-select feature-pill plan-toggle${on ? " on" : ""}`}
      aria-pressed={on}
      onClick={() => onChange(!on)}
      title={on ? "계획 먼저 끄기: 요청하면 바로 진행합니다" : "계획 먼저: 고치기 전에 계획을 보여 주고, 확인하면 진행합니다"}
    >
      <Icon name="page" size={14} />
      <span className="pill-label">계획 먼저</span>
    </button>
  );
}

/** Plan steps written as a numbered or bulleted list in the plan's text. */
const stepCount = (text: string | null) => (text ?? "").split("\n").filter((line) => /^\s*(\d+[.)]|[-*])\s+\S/.test(line)).length;

/**
 * A plan waiting for the go-ahead, as the entry (작업 칸): who planned, the question, the plan
 * itself, what going ahead does; then 더 다듬기 / 계획대로 진행, the second the one filled key.
 */
export function PlanApproval({ item, provider, onAnswer }: { item: Approval; provider?: Provider; onAnswer: (decision: "accept" | "decline") => void }) {
  if (item.decision !== null) {
    const label = item.decision === "accept" ? "계획대로 진행함" : item.decision === "decline" ? "계획을 더 다듬기로 함" : "다른 요청으로 넘어감";
    return (
      <div className="approval-done plan-done entry entry-line" data-kind="plan" data-state="settled">
        <div className="entry-head">
          <Icon name={item.decision === "accept" ? "check" : "page"} size={14} />
          <span className="entry-who">{label}</span>
          <time className="entry-when" dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>
        </div>
      </div>
    );
  }
  const steps = stepCount(item.detail);
  return (
    <div className="approval-card plan-approval entry" data-kind="plan" data-state="waiting" role="alert">
      <div className="entry-head">
        {provider ? <EngineMark provider={provider} size={15} /> : <Icon name="page" size={14} />}
        <span className="entry-who">{provider ? `${PROVIDER_LABEL[provider]}가 ` : ""}계획을 세웠습니다</span>
        <StateWord state={ROW_STATES.attention} className="entry-state" />
        <time className="entry-when" dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>
      </div>
      <p className="entry-question approval-title">{item.title}</p>
      {item.detail ? (
        <div className="entry-body plan-approval-text markdown">
          <Markdown remarkPlugins={REMARK_BASE}>{item.detail}</Markdown>
        </div>
      ) : (
        <p className="entry-body approval-reason">위 답의 계획을 확인해 주세요.</p>
      )}
      <dl className="entry-cells">
        {steps ? <div className="entry-cell"><dt>단계</dt><dd>{steps}단계</dd></div> : null}
        <div className="entry-cell"><dt>진행하면</dt><dd>지금 권한으로 계획을 실행합니다</dd></div>
        <div className="entry-cell"><dt>더 다듬으면</dt><dd>입력창에 고칠 점을 적어 보내면 다시 계획합니다</dd></div>
      </dl>
      <div className="entry-keys approval-actions">
        <button type="button" className="button" onClick={() => onAnswer("decline")} title="계획을 고칠 점을 입력창에 적어 보내면 다시 계획합니다">
          더 다듬기 <kbd>Esc</kbd>
        </button>
        <button type="button" className="button primary" onClick={() => onAnswer("accept")}>
          계획대로 진행 <kbd>Enter</kbd>
        </button>
      </div>
    </div>
  );
}
