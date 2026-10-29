import { PARTIAL_PROPOSAL, TURN_BREAK_LABEL, type Proposal } from "@workbench/contracts";
import { Icon } from "./Icon.tsx";
import "../styles/recovery.css";

// "끊기는 길" on screen: a proposal kept from a turn that did not finish, reviewed and applied or
// discarded by the user as usual.

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

