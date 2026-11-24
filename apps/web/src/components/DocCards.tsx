import { createContext, useContext, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import { REMARK_BASE } from "../markdown/plugins.ts";
import { diagramComponents } from "./Diagram.tsx";

const DRAWN = diagramComponents();
import { PROVIDER_LABEL, isOfficeFormat, type Artifact, type DocFormat, type Handoff, type Proposal, type RefSummary } from "@workbench/contracts";
import { ago } from "../format.ts";
import { changeKindLabel, designChanges, firstChangedPage, proposalTexts, useDesignThumb, type DesignChange } from "../design.ts";
import type { State } from "../state.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import { HandoffResend, PartialNote } from "./Recovery.tsx";
import { appendDraft, quotedAnswer } from "../draft.ts";
import { useOfficePage } from "../office.ts";

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
  /** 이름 바꾸기 for a document (its head's name and ⋯, the list row's menu): opens the dialog. */
  renameDocument?: (artifactId: string) => void;
  /** A file link in an answer, on a phone joined to the PC (remote-links.ts): true when it was handled here. */
  openLink?: (href: string) => boolean;
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
  epub: "전자책",
  doc: "DOC",
  ppt: "PPT",
  ods: "ODS",
};

export function FormatBadge({ format }: { format: DocFormat }) {
  return <span className={`format-badge format-${format}`}>{FORMAT_MARK[format]}</span>;
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

/** First page of a design revision, drawn small: a picture is shown, not named. */
function DesignCardThumb({ artifactId, revision }: { artifactId: string; revision: number }) {
  const thumb = useDesignThumb({ artifactId, revision }, 0, 240);
  return <span className="design-card-thumb">{thumb.url ? <img src={thumb.url} alt="" /> : <span className="design-thumb-wait">{thumb.error ? "미리보기 없음" : ""}</span>}</span>;
}

/** First page of a Word/PowerPoint/Excel revision, as IeumOffice renders it. */
function OfficeCardThumb({ artifactId, revision }: { artifactId: string; revision: number }) {
  const image = useOfficePage({ artifactId, revision }, 1);
  return <span className="design-card-thumb">{image.url ? <img src={image.url} alt="" /> : <span className="design-thumb-wait">{image.error ? "미리보기 없음" : ""}</span>}</span>;
}

/**
 * A file the work made or changed: one line that opens it, as a link in a note. What had a
 * preview keeps it in place of the format badge: a design's picture, an Office file's first page.
 */
export function FileCard({ artifact, revision, change }: { artifact: Artifact; revision: number; change: "created" | "modified" }) {
  const { actions } = useDocs();
  const newer = artifact.revision > revision;
  const preview = artifact.format === "design" ? <DesignCardThumb artifactId={artifact.id} revision={revision} />
    : isOfficeFormat(artifact.format) ? <OfficeCardThumb artifactId={artifact.id} revision={revision} /> : null;
  // The entry folded to one row (작업 칸, .entry-file): the file and its facts as ruled cells.
  return (
    <button type="button" className={`doc-card entry-file${preview ? " with-thumb" : ""}`} data-kind="file" onClick={() => actions.openArtifact(artifact.id)} title={`${artifact.path} 열기`}>
      {preview ?? <FormatBadge format={artifact.format} />}
      <span className="doc-card-name">{artifact.name}</span>
      <span className="entry-cells inline doc-card-meta">
        <span className="entry-cell">{change === "created" ? "새 파일" : "고친 파일"}</span>
        <span className="entry-cell">{revision}판</span>
        {newer ? <span className="entry-cell now">지금 {artifact.revision}판</span> : null}
        {artifact.diskState !== "same" ? <span className="entry-cell problem">디스크와 다름</span> : null}
      </span>
      <Icon name="arrowRight" size={14} className="doc-card-open" />
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

/** A Hangul proposal that no longer holds something its base revision held: said before applying, not refused. */
export const removedLine = (removed: string[]) => `이 수정안을 적용하면 없어집니다: ${removed.join(", ")}`;

const lines = (n: number, verb: string) => `${n}줄 ${verb}`;
const clock = (at: number) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * A proposal as the entry (작업 칸): whose proposal, the document, the revision it was made on and
 * what it changes as ruled cells; 미리보기 aside, 취소 and 적용 at the foot. `primary`: this is the
 * entry that holds the view's one filled key (a waiting approval, or a newer proposal, takes it).
 */
export function ProposalCard({ proposal, primary = true }: { proposal: Proposal; primary?: boolean }) {
  const { state, actions } = useDocs();
  const artifact = state.artifacts[proposal.artifactId];
  const session = state.sessions[proposal.sessionId];
  if (!artifact) return null;
  const stale = proposal.status === "pending" && artifact.revision !== proposal.baseRevision;
  const engine = session ? PROVIDER_LABEL[session.provider] : "AI";
  const pictured = artifact.format === "design" || isOfficeFormat(artifact.format);
  // Waiting: the one that holds the view's filled key leads (ink head); another waits its turn (queued).
  const entryState = proposal.status === "pending" ? (primary ? "waiting" : "queued") : proposal.status === "running" ? "running" : "settled";
  const when = proposal.status === "running" ? <span className="entry-when"><span className="spinner small" /> 만드는 중</span>
    : proposal.status === "applied" ? <span className="entry-when done">적용함</span>
      : proposal.status === "discarded" ? <span className="entry-when">버림</span>
        : proposal.status === "empty" ? <span className="entry-when">바뀐 내용 없음</span>
          : stale ? <span className="entry-when problem">이전 판 기준</span>
            : proposal.createdAt ? <time className="entry-when" dateTime={new Date(proposal.createdAt).toISOString()}>{clock(proposal.createdAt)}</time> : null;
  return (
    <div className={`proposal-card entry status-${proposal.status}${stale ? " stale" : ""}`} data-kind="proposal" data-state={entryState}>
      <div className="entry-head proposal-head">
        {session ? <EngineMark provider={session.provider} size={15} /> : null}
        <span className="entry-who proposal-title">{engine}의 수정안</span>
        {when}
      </div>
      <dl className="entry-cells proposal-meta">
        <div className="entry-cell"><dt>문서</dt><dd>{artifact.name}</dd></div>
        <div className="entry-cell"><dt>{proposal.status === "applied" && proposal.appliedRevision ? "판" : "만든 판"}</dt><dd>{proposal.status === "applied" && proposal.appliedRevision ? `${proposal.baseRevision}판에서 ${proposal.appliedRevision}판으로` : `${proposal.baseRevision}판`}</dd></div>
        {pictured ? null : (
          <div className="entry-cell">
            <dt>바뀐 줄</dt>
            <dd>
              {!proposal.added && !proposal.removed ? "없음" : null}
              {proposal.added ? <span className="diff-add">{lines(proposal.added, "더함")}</span> : null}
              {proposal.added && proposal.removed ? ", " : null}
              {proposal.removed ? <span className="diff-del">{lines(proposal.removed, "뺌")}</span> : null}
            </dd>
          </div>
        )}
        {stale ? <div className="entry-cell"><dt>문서는 지금</dt><dd>{artifact.revision}판</dd></div> : null}
      </dl>
      {proposal.interruptedBy ? <div className="entry-body"><PartialNote proposal={proposal} /></div> : null}
      {artifact.format === "design" && proposal.status !== "running" && proposal.status !== "empty" ? <div className="entry-body"><DesignProposalPreview proposal={proposal} /></div> : null}
      {isOfficeFormat(artifact.format) && proposal.status !== "running" && proposal.status !== "empty" ? <div className="entry-body"><OfficeProposalPreview proposal={proposal} /></div> : null}
      {proposal.problem && proposal.status === "pending" ? <p className="entry-note problem proposal-warning">디자인 파일이 올바르지 않아 적용할 수 없습니다: {proposal.problem}</p> : null}
      {proposal.removedStructure?.length && proposal.status === "pending" ? <p className="entry-note proposal-warning">{removedLine(proposal.removedStructure)}</p> : null}
      {proposal.status === "pending" ? (
        stale ? (
          <>
            <p className="entry-note proposal-warning">
              문서가 지금 {artifact.revision}판입니다. 이전 판으로 만든 수정안이라 자동으로 적용하지 않습니다.
            </p>
            <div className="entry-keys proposal-actions">
              <span className="entry-aside">
                <button type="button" className="button small" onClick={() => actions.openArtifact(artifact.id, proposal.id)}>
                  차이 보기
                </button>
              </span>
              <button type="button" className="button small" onClick={() => actions.discardProposal(proposal)}>
                버리기
              </button>
              <button type="button" className={primary ? "button small primary" : "button small"} onClick={() => actions.retryProposal(proposal)}>
                최신 판({artifact.revision}판)으로 다시 요청
              </button>
            </div>
          </>
        ) : (
          <div className="entry-keys proposal-actions">
            <span className="entry-aside">
              <button type="button" className="button small" onClick={() => actions.openArtifact(artifact.id, proposal.id)}>
                미리보기
              </button>
            </span>
            <button type="button" className="button small" onClick={() => actions.discardProposal(proposal)}>
              취소
            </button>
            {proposal.problem ? null : (
              <button type="button" className={primary ? "button small primary" : "button small"} onClick={() => actions.applyProposal(proposal)}>
                적용
              </button>
            )}
          </div>
        )
      ) : (
        <div className="entry-keys proposal-done">
          <button type="button" className="link" onClick={() => actions.openArtifact(artifact.id)}>
            문서 열기
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A request sent to another session, as the entry (작업 칸): where it went and its state in the
 * head, what was sent as cells, the answer in the body (no box inside), the actions at the foot.
 */
export function HandoffCard({ handoff, viewer }: { handoff: Handoff; viewer: string }) {
  const { state, actions } = useDocs();
  const [open, setOpen] = useState(false);
  const target = state.sessions[handoff.targetSessionId];
  const source = state.sessions[handoff.sourceSessionId];
  const outgoing = viewer === handoff.sourceSessionId;
  if (!outgoing) return null;
  const targetWork = target ? state.works[target.workId] : undefined;
  const running = handoff.status === "sent";
  const entryState = running ? "running" : handoff.status === "failed" ? "failed" : "settled";
  return (
    <div className={`handoff-card entry status-${handoff.status}`} data-kind="handoff" data-state={entryState}>
      <div className="entry-head handoff-head">
        {target ? <EngineMark provider={target.provider} size={15} /> : <Icon name="send" size={14} />}
        <span className="entry-who">{target?.purpose ?? "대화"}에 보냄</span>
        <span className={`entry-when handoff-status tone-${handoff.status}${handoff.status === "answered" ? " done" : handoff.status === "failed" ? " problem" : ""}`}>
          {running ? (
            <>
              <span className="spinner small" /> {target?.status === "awaitingApproval" ? "상대 대화가 승인을 기다림" : "확인 중"}
            </>
          ) : handoff.status === "answered" ? (
            `답 도착 ${ago(handoff.answeredAt)}`
          ) : (
            `실패: ${handoff.error ?? ""}`
          )}
        </span>
      </div>
      <dl className="entry-cells">
        <div className="entry-cell wide"><dt>보낸 요청</dt><dd className="handoff-request">{handoff.text}</dd></div>
        {targetWork && targetWork.id !== state.sessions[handoff.sourceSessionId]?.workId ? <div className="entry-cell wide"><dt>받은 프로젝트</dt><dd>{targetWork.title}</dd></div> : null}
        {handoff.refs.length ? (
          <div className="entry-cell wide">
            <dt>함께 보낸 문서</dt>
            <dd className="ref-chips">
              {handoff.refs.map((ref) => (
                <span key={`${ref.artifactId}:${ref.revision}`} className="ref-chip">
                  <Icon name="file" size={12} /> {state.artifacts[ref.artifactId]?.name ?? "문서"}
                  <span className="ref-chip-fact">{ref.revision}판</span>
                  {ref.selection ? <span className="ref-chip-fact">{ref.selection.label}</span> : null}
                </span>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
      {handoff.reply ? (
        <div className={`entry-body handoff-reply${open ? " open" : ""}`}>
          <span className="entry-label">받은 답</span>
          <div className="markdown">
            <Markdown remarkPlugins={REMARK_BASE} components={open ? DRAWN : undefined}>
              {open ? handoff.reply : handoff.reply.slice(0, 400) + (handoff.reply.length > 400 ? "…" : "")}
            </Markdown>
          </div>
        </div>
      ) : null}
      <div className="entry-keys handoff-actions">
        <span className="entry-aside">
          {handoff.reply && handoff.reply.length > 400 ? (
            <button type="button" className="link" onClick={() => setOpen(!open)}>
              {open ? "접기" : "답 전체 보기"}
            </button>
          ) : null}
        </span>
        {handoff.reply && source ? (
          <button
            type="button"
            className="link"
            title="이 답을 입력창에 인용으로 넣습니다. 다음 요청과 함께 이 대화의 엔진에 갑니다."
            onClick={() => appendDraft(`work:${source.workId}:${source.id}`, quotedAnswer(target ? `${PROVIDER_LABEL[target.provider]} · ${target.purpose}` : "다른 대화", handoff.reply!))}
          >
            대화에 넣기
          </button>
        ) : null}
        <button type="button" className="link" onClick={() => actions.openSession(handoff.targetSessionId)}>
          {target ? `${PROVIDER_LABEL[target.provider]} 대화 열기` : "대화 열기"}
        </button>
        <HandoffResend handoff={handoff} onResend={actions.resendHandoff} />
      </div>
    </div>
  );
}

export function RefChips({ refs }: { refs: RefSummary[] }) {
  const { actions, state } = useDocs();
  return (
    <div className="ref-chips">
      {refs.map((ref) => (
        <button key={`${ref.artifactId}:${ref.revision}`} type="button" className="ref-chip" title={ref.sha256 ? `참조한 판의 SHA-256: ${ref.sha256}` : undefined} onClick={() => actions.openArtifact(ref.artifactId)}>
          <Icon name="file" size={12} /> {state.artifacts[ref.artifactId]?.name ?? ref.name}
          <span className="ref-chip-fact">{ref.revision}판</span>
          <span className="ref-chip-fact">{ref.mode === "edit" ? "수정 요청" : "읽기"}</span>
          {ref.savedSnapshot ? <span className="ref-chip-fact">미저장 편집 제외</span> : null}
          {ref.selection ? <span className="ref-chip-fact">{ref.selection}</span> : null}
        </button>
      ))}
    </div>
  );
}
