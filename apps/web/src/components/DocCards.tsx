import { createContext, useContext, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FORMAT_LABEL, PROVIDER_LABEL, type Artifact, type DocFormat, type Handoff, type Proposal, type RefSummary } from "@workbench/contracts";
import { accentStyle, useAppearance } from "../appearance.ts";
import { ago } from "../format.ts";
import type { State } from "../state.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";

// Cards for documents inside the conversation: files an engine wrote, proposals waiting for a
// decision, and requests sent to other sessions with their answers.

export type DocActions = {
  openArtifact: (artifactId: string, proposalId?: string) => void;
  applyProposal: (proposal: Proposal) => void;
  discardProposal: (proposal: Proposal) => void;
  /** Ask again on the latest revision (a proposal made on an older one). */
  retryProposal: (proposal: Proposal) => void;
  openSession: (sessionId: string) => void;
};

export const DocContext = createContext<{ state: State; actions: DocActions } | null>(null);

export function useDocs() {
  const value = useContext(DocContext);
  if (!value) throw new Error("DocContext missing");
  return value;
}

const FORMAT_MARK: Record<DocFormat, string> = { markdown: "MD", html: "HTML", pdf: "PDF", hwpx: "HWPX", hwp: "HWP", text: "TXT" };

export function FormatBadge({ format }: { format: DocFormat }) {
  return <span className={`format-badge format-${format}`}>{FORMAT_MARK[format]}</span>;
}

export function FileCard({ artifact, revision, change }: { artifact: Artifact; revision: number; change: "created" | "modified" }) {
  const { actions } = useDocs();
  const newer = artifact.revision > revision;
  return (
    <button type="button" className="doc-card" onClick={() => actions.openArtifact(artifact.id)} title={artifact.path}>
      <FormatBadge format={artifact.format} />
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
          r{proposal.baseRevision} 기준 · <span className="diff-add">+{proposal.added}</span> <span className="diff-del">−{proposal.removed}</span>
        </span>
      </div>
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
            <button type="button" className="button small primary" onClick={() => actions.applyProposal(proposal)}>
              적용
            </button>
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
            <Markdown remarkPlugins={[remarkGfm]}>{open ? handoff.reply : handoff.reply.slice(0, 400) + (handoff.reply.length > 400 ? "…" : "")}</Markdown>
          </div>
        </div>
      ) : null}
      <div className="handoff-actions">
        {handoff.reply && handoff.reply.length > 400 ? (
          <button type="button" className="link" onClick={() => setOpen(!open)}>
            {open ? "접기" : "답 전체 보기"}
          </button>
        ) : null}
        <button type="button" className="link" onClick={() => actions.openSession(handoff.targetSessionId)}>
          {target ? `${PROVIDER_LABEL[target.provider]} 세션 열기` : "세션 열기"}
        </button>
      </div>
    </div>
  );
}

export function RefChips({ refs }: { refs: RefSummary[] }) {
  const { actions } = useDocs();
  return (
    <div className="ref-chips">
      {refs.map((ref) => (
        <button key={`${ref.artifactId}:${ref.revision}`} type="button" className="ref-chip" onClick={() => actions.openArtifact(ref.artifactId)}>
          <Icon name="file" size={12} /> {ref.name} · r{ref.revision} · {ref.mode === "edit" ? "수정 요청" : "읽기"}
          {ref.selection ? ` · ${ref.selection}` : ""}
        </button>
      ))}
    </div>
  );
}
