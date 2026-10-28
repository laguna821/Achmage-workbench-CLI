import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptItem } from "@workbench/contracts";
import { Icon } from "./Icon.tsx";
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

/** A plan waiting for the go-ahead: run it as planned, or keep refining it. */
export function PlanApproval({ item, onAnswer }: { item: Approval; onAnswer: (decision: "accept" | "decline") => void }) {
  if (item.decision !== null) {
    const label = item.decision === "accept" ? "계획대로 진행함" : item.decision === "decline" ? "계획을 더 다듬기로 함" : "다른 요청으로 넘어감";
    return (
      <div className="approval-done plan-done">
        <Icon name={item.decision === "accept" ? "check" : "page"} size={14} />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <div className="approval-card plan-approval" role="alert">
      <div className="approval-title">{item.title}</div>
      {item.detail ? (
        <div className="plan-approval-text markdown">
          <Markdown remarkPlugins={[remarkGfm]}>{item.detail}</Markdown>
        </div>
      ) : (
        <div className="approval-reason">위 계획을 확인해 주세요. 진행하면 지금 권한으로 실행합니다.</div>
      )}
      <div className="approval-actions">
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
