import { createContext, useContext, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diagramComponents } from "./Diagram.tsx";

const DRAWN = diagramComponents();
import { FORMAT_LABEL, PROVIDER_LABEL, isOfficeFormat, type Artifact, type DocFormat, type Handoff, type Proposal, type RefSummary } from "@workbench/contracts";
import { accentStyle, useAppearance } from "../appearance.ts";
import { ago } from "../format.ts";
import { changeKindLabel, designChanges, firstChangedPage, proposalTexts, useDesignThumb, type DesignChange } from "../design.ts";
import { useOfficePage } from "../office.ts";
import type { State } from "../state.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import { HandoffResend, PartialNote } from "./Recovery.tsx";
import { appendDraft, quotedAnswer } from "../draft.ts";

// Cards for documents inside the conversation: files an engine wrote, proposals waiting for a
// decision, and requests sent to other sessions with their answers.

export type DocActions = {
  openArtifact: (artifactId: string, proposalId?: string) => void;
  applyProposal: (proposal: Proposal) => void;
  discardProposal: (proposal: Proposal) => void;
  /** Ask again on the latest revision (a proposal made on an older one). */
  retryProposal: (proposal: Proposal) => void;
  openSession: (sessionId: string) => void;
  /** "다시 보내기": a request the other session did not answer, as a new one. */
  resendHandoff: (handoff: Handoff) => Promise<void>;
};

export const DocContext = createContext<{ state: State; actions: DocActions } | null>(null);

export function useDocs() {
  const value = useContext(DocContext);
  if (!value) throw new Error("DocContext missing");
  return value;
}

const FORMAT_MARK: Record<DocFormat, string> = {
  markdown: "MD",
  html: "HTML",
  pdf: "PDF",
  hwpx: "HWPX",
  hwp: "HWP",
  text: "TXT",
  design: "디자인",
  docx: "DOCX",
  pptx: "PPTX",
  xlsx: "XLSX",
  xmind: "지도",
};

export function FormatBadge({ format }: { format: DocFormat }) {
  return <span className={`format-badge format-${format}`}>{FORMAT_MARK[format]}</span>;
}

/** First page of a design revision, drawn small for the conversation. */
function DesignCardThumb({ artifactId, revision }: { artifactId: string; revision: number }) {
  const thumb = useDesignThumb({ artifactId, revision }, 0, 240);
  return <span className="design-card-thumb">{thumb.url ? <img src={thumb.url} alt="" /> : <span className="design-thumb-wait">{thumb.error ? "미리보기 없음" : ""}</span>}</span>;
}

/** First page of a Word/PowerPoint/Excel revision, as IeumOffice renders it. */
function OfficeCardThumb({ artifactId, revision }: { artifactId: string; revision: number }) {
  const image = useOfficePage({ artifactId, revision }, 1);
  return <span className="design-card-thumb">{image.url ? <img src={image.url} alt="" /> : <span className="design-thumb-wait">{image.error ? "미리보기 없음" : ""}</span>}</span>;
}

/** Base and proposed first pages of a Word/PowerPoint/Excel proposal. */
function OfficeProposalPreview({ proposal }: { proposal: Proposal }) {
  const before = useOfficePage({ proposalId: proposal.id, side: "base" }, 1);
  const after = useOfficePage(proposal.problem ? null : { proposalId: proposal.id, side: "proposed" }, 1);
  return (
    <div className="design-proposal">
      <div className="design-proposal-pair">
        <figure>
          <figcaption>r{proposal.baseRevision}</figcaption>
          {before.url ? <img src={before.url} alt="수정 전 첫 쪽" /> : <div className="design-thumb-wait">{before.error ?? ""}</div>}
        </figure>
        <Icon name="arrowRight" size={14} />
        <figure>
          <figcaption>수정안</figcaption>
          {proposal.problem ? <div className="design-thumb-wait">파일 오류</div> : after.url ? <img src={after.url} alt="수정안 첫 쪽" /> : <div className="design-thumb-wait">{after.error ?? ""}</div>}
        </figure>
      </div>
    </div>
  );
}

export function FileCard({ artifact, revision, change }: { artifact: Artifact; revision: number; change: "created" | "modified" }) {
  const { actions } = useDocs();
  const newer = artifact.revision > revision;
  return (
    <button
      type="button"
      className={`doc-card${artifact.format === "design" || isOfficeFormat(artifact.format) ? " design" : ""}`}
      onClick={() => actions.openArtifact(artifact.id)}
      title={artifact.path}
    >
      {artifact.format === "design" ? (
        <DesignCardThumb artifactId={artifact.id} revision={revision} />
      ) : isOfficeFormat(artifact.format) ? (
        <OfficeCardThumb artifactId={artifact.id} revision={revision} />
      ) : (
        <FormatBadge format={artifact.format} />
      )}
      <span className="doc-card-main">
        <span className="doc-card-name">{artifact.name}</span>
        <span className="doc-card-meta">
          {change === "created" ? "새 파일" : "수정"} · r{revision}
          {newer ? ` · 지금 r${artifact.revision}` : ""}
          {artifact.diskState !== "same" ? " · 디스크와 다름" : ""} · {FORMAT_LABEL[artifact.format]}
        </span>
      </span>
      <span className="doc-card-open">
        열기 <Icon name="arrowRight" size={14} />
      </span>
    </button>
  );
}

/** Before and after of the page an AI changed, with the first few changes in words. */
function DesignProposalPreview({ proposal }: { proposal: Proposal }) {
  const [changes, setChanges] = useState<DesignChange[] | null>(null);
  useEffect(() => {
    let active = true;
    proposalTexts(proposal.id)
      .then(([base, proposed]) => active && setChanges(designChanges(base, proposed) ?? []))
      .catch(() => active && setChanges([]));
    return () => {
      active = false;
    };
  }, [proposal.id]);
  const page = useMemo(() => firstChangedPage(changes), [changes]);
  const before = useDesignThumb(changes ? { artifactId: proposal.artifactId, proposalId: proposal.id, side: "base" } : null, page, 280);
  const after = useDesignThumb(changes && !proposal.problem ? { artifactId: proposal.artifactId, proposalId: proposal.id, side: "proposed" } : null, page, 280);
  return (
    <div className="design-proposal">
      <div className="design-proposal-pair">
        <figure>
          <figcaption>r{proposal.baseRevision}</figcaption>
          {before.url ? <img src={before.url} alt={`수정 전 ${page + 1}쪽`} /> : <div className="design-thumb-wait" />}
        </figure>
        <Icon name="arrowRight" size={14} />
        <figure>
          <figcaption>수정안</figcaption>
          {proposal.problem ? <div className="design-thumb-wait">파일 오류</div> : after.url ? <img src={after.url} alt={`수정안 ${page + 1}쪽`} /> : <div className="design-thumb-wait" />}
        </figure>
      </div>
      {changes?.length ? (
        <ul className="design-changes compact">
          {changes.slice(0, 4).map((change, index) => (
            <li key={index} className={`design-change kind-${change.kind}`}>
              <span className="design-change-kind">{changeKindLabel(change.kind)}</span>
              <span className="design-change-label">
                {change.page + 1}쪽 · {change.kind === "text" && change.detail ? change.detail : change.label}
              </span>
            </li>
          ))}
          {changes.length > 4 ? <li className="muted">그 밖에 {changes.length - 4}건</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

export function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { state, actions } = useDocs();
  const { lookOf } = useAppearance();
  const artifact = state.artifacts[proposal.artifactId];
  const session = state.sessions[proposal.sessionId];
  if (!artifact) return null;
  const stale = proposal.status === "pending" && artifact.revision !== proposal.baseRevision;
  const engine = session ? PROVIDER_LABEL[session.provider] : "AI";
  return (
    <div className={`proposal-card status-${proposal.status}${stale ? " stale" : ""}`} style={session ? accentStyle(lookOf(session.provider)) : undefined}>
      <div className="proposal-head">
        {session ? <EngineMark provider={session.provider} size={15} /> : null}
        <span className="proposal-title">
          {engine}의 수정안 · {artifact.name}
        </span>
        <span className="proposal-meta">
          r{proposal.baseRevision} 기준
          {artifact.format === "design" || isOfficeFormat(artifact.format) ? null : (
            <>
              {" "}
              · <span className="diff-add">+{proposal.added}</span> <span className="diff-del">−{proposal.removed}</span>
            </>
          )}
        </span>
      </div>
      <PartialNote proposal={proposal} />
      {artifact.format === "design" && proposal.status !== "running" && proposal.status !== "empty" ? <DesignProposalPreview proposal={proposal} /> : null}
      {isOfficeFormat(artifact.format) && proposal.status !== "running" && proposal.status !== "empty" ? <OfficeProposalPreview proposal={proposal} /> : null}
      {proposal.problem && proposal.status === "pending" ? <div className="proposal-warning">디자인 파일이 올바르지 않아 적용할 수 없습니다: {proposal.problem}</div> : null}
      {proposal.status === "pending" ? (
        stale ? (
          <>
            <div className="proposal-warning">
              문서가 지금 r{artifact.revision}입니다. 이전 판 기준 수정안이라 자동으로 적용하지 않습니다.
            </div>
            <div className="proposal-actions">
              <button type="button" className="button small" onClick={() => actions.openArtifact(artifact.id, proposal.id)}>
                차이 보기
              </button>
              <button type="button" className="button small primary" onClick={() => actions.retryProposal(proposal)}>
                최신 판(r{artifact.revision})으로 다시 요청
              </button>
              <button type="button" className="button small" onClick={() => actions.discardProposal(proposal)}>
                버리기
              </button>
            </div>
          </>
        ) : (
          <div className="proposal-actions">
            <button type="button" className="button small" onClick={() => actions.openArtifact(artifact.id, proposal.id)}>
              미리보기
            </button>
            {proposal.problem ? null : (
              <button type="button" className="button small primary" onClick={() => actions.applyProposal(proposal)}>
                적용
              </button>
            )}
            <button type="button" className="button small" onClick={() => actions.discardProposal(proposal)}>
              취소
            </button>
          </div>
        )
      ) : (
        <div className="proposal-done">
          {proposal.status === "applied"
            ? `적용됨 → r${proposal.appliedRevision}`
            : proposal.status === "discarded"
              ? "버림"
              : proposal.status === "running"
                ? "만드는 중…"
                : "바뀐 내용 없음"}
          <button type="button" className="link" onClick={() => actions.openArtifact(artifact.id)}>
            문서 열기
          </button>
        </div>
      )}
    </div>
  );
}

export function HandoffCard({ handoff, viewer }: { handoff: Handoff; viewer: string }) {
  const { state, actions } = useDocs();
  const { lookOf } = useAppearance();
  const [open, setOpen] = useState(false);
  const target = state.sessions[handoff.targetSessionId];
  const source = state.sessions[handoff.sourceSessionId];
  const outgoing = viewer === handoff.sourceSessionId;
  if (!outgoing) return null;
  const targetWork = target ? state.works[target.workId] : undefined;
  const running = handoff.status === "sent";
  return (
    <div className={`handoff-card status-${handoff.status}`} style={target ? accentStyle(lookOf(target.provider)) : undefined}>
      <div className="handoff-head">
        <Icon name="send" size={14} />
        <span>
          {target ? <EngineMark provider={target.provider} size={14} /> : null} {target?.purpose ?? "세션"}
          {targetWork && targetWork.id !== state.sessions[handoff.sourceSessionId]?.workId ? ` · ${targetWork.title}` : ""}에 보냄
        </span>
        <span className={`handoff-status tone-${handoff.status}`}>
          {running ? (
            <>
              <span className="spinner small" /> {target?.status === "awaitingApproval" ? "상대 세션이 승인을 기다림" : "확인 중"}
            </>
          ) : handoff.status === "answered" ? (
            `답 도착 · ${ago(handoff.answeredAt)}`
          ) : (
            `실패 · ${handoff.error ?? ""}`
          )}
        </span>
      </div>
      <div className="handoff-request">{handoff.text}</div>
      {handoff.refs.length ? (
        <div className="ref-chips">
          {handoff.refs.map((ref) => (
            <span key={`${ref.artifactId}:${ref.revision}`} className="ref-chip">
              <Icon name="file" size={12} /> {state.artifacts[ref.artifactId]?.name ?? "문서"} · r{ref.revision}
              {ref.selection ? ` · ${ref.selection.label}` : ""}
            </span>
          ))}
        </div>
      ) : null}
      {handoff.reply ? (
        <div className={`handoff-reply${open ? " open" : ""}`}>
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]} components={open ? DRAWN : undefined}>
              {open ? handoff.reply : handoff.reply.slice(0, 400) + (handoff.reply.length > 400 ? "…" : "")}
            </Markdown>
          </div>
        </div>
      ) : null}
      <div className="handoff-actions">
        {handoff.reply && handoff.reply.length > 400 ? (
          <button type="button" className="link" onClick={() => setOpen(!open)}>
            {open ? "접기" : "답 전체 보기"}
          </button>
        ) : null}
        {handoff.reply && source ? (
          <button
            type="button"
            className="link"
            title="이 답을 입력창에 인용으로 넣습니다. 다음 요청과 함께 이 세션의 엔진에 갑니다."
            onClick={() => appendDraft(`work:${source.workId}:${source.id}`, quotedAnswer(target ? `${PROVIDER_LABEL[target.provider]} · ${target.purpose}` : "다른 세션", handoff.reply!))}
          >
            대화에 넣기
          </button>
        ) : null}
        <button type="button" className="link" onClick={() => actions.openSession(handoff.targetSessionId)}>
          {target ? `${PROVIDER_LABEL[target.provider]} 세션 열기` : "세션 열기"}
        </button>
        <HandoffResend handoff={handoff} onResend={actions.resendHandoff} />
      </div>
    </div>
  );
}

export function RefChips({ refs }: { refs: RefSummary[] }) {
  const { actions } = useDocs();
  return (
    <div className="ref-chips">
      {refs.map((ref) => (
        <button key={`${ref.artifactId}:${ref.revision}`} type="button" className="ref-chip" title={ref.sha256 ? `참조한 판의 SHA-256: ${ref.sha256}` : undefined} onClick={() => actions.openArtifact(ref.artifactId)}>
          <Icon name="file" size={12} /> {ref.name} · r{ref.revision} · {ref.mode === "edit" ? "수정 요청" : "읽기"}
          {ref.savedSnapshot ? " · 미저장 편집 제외" : ""}
          {ref.selection ? ` · ${ref.selection}` : ""}
        </button>
      ))}
    </div>
  );
}
