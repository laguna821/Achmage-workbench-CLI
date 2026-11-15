import { useRef, useState, type ReactNode } from "react";
import { PROVIDER_LABEL, type Proposal, type Session } from "@workbench/contracts";
import { EngineMark } from "../EngineMark.tsx";
import { Icon } from "../Icon.tsx";
import { PartialNote } from "../Recovery.tsx";
import { AnchoredLayer } from "../ui/AnchoredLayer.tsx";
import { linesWord, revisionWord } from "./doc-notices.ts";

type Props = {
  proposals: Proposal[];
  sessions: Record<string, Session>;
  /** The document's revision now: a proposal made from an older one is not applied by itself. */
  revision: number;
  /** Pictured documents (design, Word/PowerPoint/Excel, Hangul) count no lines. */
  pictured: boolean;
  /** This band holds the view's one filled key (nothing more urgent holds it). */
  primary: boolean;
  onCompare: (proposal: Proposal) => void;
  onApply: (proposal: Proposal) => void;
  onDiscard: (proposal: Proposal) => void;
};

function ProposalLine({ proposal, sessions, revision, pictured, primary, onCompare, onApply, onDiscard, more }: Omit<Props, "proposals"> & { proposal: Proposal; more?: ReactNode }) {
  const owner = sessions[proposal.sessionId];
  const engine = owner ? PROVIDER_LABEL[owner.provider] : "AI";
  const stale = proposal.status === "pending" && revision !== proposal.baseRevision;
  const running = proposal.status === "running";
  return (
    <div className="entry-head doc-proposal-head">
      {owner ? <EngineMark provider={owner.provider} size={16} /> : <Icon name="edit" size={16} />}
      <span className="entry-who">{engine}의 수정안</span>
      <span className="entry-cells inline doc-proposal-facts">
        <span className="entry-cell">{revisionWord(proposal.baseRevision)} 기준</span>
        {running ? <span className="entry-cell now"><span className="spinner small" aria-hidden /> 만드는 중</span>
          : pictured ? (proposal.problem ? <span className="entry-cell problem">파일 오류</span> : null)
            : <span className="entry-cell">{linesWord(proposal.added, proposal.removed)}</span>}
        {stale ? <span className="entry-cell problem">문서는 지금 {revisionWord(revision)}, 자동 적용 안 함</span> : null}
      </span>
      <PartialNote proposal={proposal} compact />
      {proposal.status === "pending" ? (
        <span className="entry-keys doc-proposal-actions">
          <button type="button" className="button small" onClick={() => onCompare(proposal)}>{stale ? "차이 보기" : "비교"}</button>
          <button type="button" className="text-button" onClick={() => onDiscard(proposal)}>취소</button>
          {!stale && !proposal.problem ? (
            <button type="button" className={`button small${primary ? " primary" : ""}`} onClick={() => onApply(proposal)}>적용</button>
          ) : null}
        </span>
      ) : null}
      {more}
    </div>
  );
}

/**
 * The document AI's proposed change as ONE band in the entry's form (U5): who proposes what, its
 * facts as inline cells, 비교 · 취소 and the single filled 적용. Several waiting proposals: the
 * newest leads, the others wait behind "외 N건" with the same keys.
 */
export function DocProposalBand(props: Props) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const ordered = [...props.proposals].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (!ordered.length) return null;
  const [lead, ...rest] = ordered;
  const leadWaits = lead.status === "pending";
  const more = rest.length ? (
    <>
      <button ref={anchor} type="button" className="text-button doc-notice-more" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`수정안 ${rest.length}건 더 보기`} onClick={() => setOpen(!open)}>
        외 {rest.length}건 <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
      <AnchoredLayer open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" label="이 문서의 다른 수정안" className="doc-notice-list doc-proposal-list">
        {rest.map((proposal) => (
          <div key={proposal.id} className="doc-proposal" data-state={proposal.status === "running" ? "running" : "queued"}>
            <ProposalLine {...props} proposal={proposal} primary={false} />
          </div>
        ))}
      </AnchoredLayer>
    </>
  ) : null;
  return (
    <section className={`entry doc-proposal doc-proposal-band${lead.status === "pending" && props.revision !== lead.baseRevision ? " stale" : ""}`}
      data-kind="proposal" data-state={leadWaits ? "queued" : "running"} aria-label="이 문서의 수정안">
      <ProposalLine {...props} proposal={lead} primary={props.primary && leadWaits} more={more} />
    </section>
  );
}
