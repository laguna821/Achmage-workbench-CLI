import { useState } from "react";
import { PARTIAL_PROPOSAL, TURN_BREAK_LABEL, type Handoff, type Proposal } from "@workbench/contracts";
import { Icon } from "./Icon.tsx";
import "../styles/recovery.css";

// "끊기는 길" on screen: a proposal kept from a turn that did not finish, and sending again a request
// another session could not answer. Both are reviewed and chosen by the user as usual.

/** On a proposal from a turn cut short: what it is, and what cut the turn. */
export function PartialNote({ proposal, compact = false }: { proposal: Proposal; compact?: boolean }) {
  if (!proposal.interruptedBy) return null;
  return (
    <span className={`partial-note${compact ? " compact" : ""}`} title="턴이 끝나기 전에 작업 사본에 들어간 수정입니다. 비교해 보고 적용하거나 버리세요.">
      <Icon name="alert" size={12} />
      <span>
        {PARTIAL_PROPOSAL}
        <span className="partial-note-why"> · {TURN_BREAK_LABEL[proposal.interruptedBy]}</span>
      </span>
    </span>
  );
}

/** On a request the other session did not answer: "다시 보내기", or that it was sent again. */
export function HandoffResend({ handoff, onResend }: { handoff: Handoff; onResend: (handoff: Handoff) => Promise<void> }) {
  const [sending, setSending] = useState(false);
  if (handoff.status !== "failed") return null;
  if (handoff.resentAs) return <span className="handoff-resent">다시 보냄</span>;
  return (
    <button
      type="button"
      className="button small handoff-resend"
      disabled={sending}
      title="같은 내용을 새 요청으로 다시 보냅니다"
      onClick={() => {
        setSending(true);
        void onResend(handoff).finally(() => setSending(false));
      }}
    >
      <Icon name="refresh" size={13} /> 다시 보내기
    </button>
  );
}
