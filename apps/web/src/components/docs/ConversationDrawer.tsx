import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PROVIDER_LABEL, type Proposal, type Session, type SessionStatus, type TranscriptItem } from "@workbench/contracts";
import { fold } from "../../../../../third_party/textfold/fold.ts";
import { statusText } from "../../format.ts";
import { isBusy, type State } from "../../state.ts";
import { ProposalCard } from "../DocCards.tsx";
import { diagramComponents } from "../Diagram.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { Icon } from "../Icon.tsx";
import { Transcript } from "../Transcript.tsx";

const DRAWN = diagramComponents();

export type DrawerMode = "closed" | "peek" | "open";

type Item<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>;

/**
 * The last reply folded to its points (textfold's fold, no model call) when that saves a quarter
 * of it; short replies, and those that hardly fold, are shown whole.
 */
export function foldedReply(text: string) {
  const folded = fold(text, 3).text;
  return text.length > 240 && folded.length <= text.length * 0.75 ? folded : null;
}

/** The turn the drawer speaks for: the last request and what came after it. */
function lastTurn(items: TranscriptItem[]) {
  let start = items.length;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.kind === "user") {
      start = index;
      break;
    }
  }
  const turn = items.slice(start);
  return {
    request: turn[0]?.kind === "user" ? turn[0] : null,
    answer: turn
      .filter((item): item is Item<"assistant"> => item.kind === "assistant")
      .map((item) => item.text)
      .join("\n\n")
      .trim(),
    proposals: turn.filter((item): item is Item<"proposal"> => item.kind === "proposal"),
    end: turn.find((item): item is Item<"turnEnd"> => item.kind === "turnEnd") ?? null,
  };
}

const firstLine = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, "");

/**
 * The conversation under a document (plan 4.6, design B-0): keep editing and keep asking. Closed it
 * is one line (what the engine is doing, the start of its last reply); "peek" shows waiting
 * approvals, the last request, the last reply folded and its proposals; "open" lays the whole
 * conversation over the document (not a split). It peeks on its own when a reply ends or an
 * approval waits.
 */
export function ConversationDrawer({
  state,
  session,
  mode,
  onMode,
  onAnswer,
  onOpenConversation,
}: {
  state: State;
  session: Session;
  mode: DrawerMode;
  onMode: (mode: DrawerMode) => void;
  onAnswer: (itemId: string, decision: "accept" | "decline") => void;
  onOpenConversation: () => void;
}) {
  const items = state.transcripts[session.id]?.items ?? [];
  const turn = lastTurn(items);
  const approvals = items.filter((item): item is Item<"approval"> => item.kind === "approval" && item.decision === null);
  const busy = isBusy(session);
  const [whole, setWhole] = useState(false);
  const folded = turn.answer ? foldedReply(turn.answer) : null;

  // A reply that ended, or an approval that waits, comes up without being asked for.
  const previous = useRef<SessionStatus>(session.status);
  useEffect(() => {
    const before = previous.current;
    previous.current = session.status;
    if (before === session.status || mode === "open") return;
    if (session.status === "awaitingApproval" || ((before === "running" || before === "starting") && (session.status === "idle" || session.status === "error"))) {
      setWhole(false);
      onMode("peek");
    }
  }, [session.status, mode, onMode]);

  const state_ = busy
    ? statusText(session)
    : turn.end
      ? turn.end.status === "completed"
        ? `끝남${turn.end.durationMs ? ` · ${Math.round(turn.end.durationMs / 1000)}초` : ""}`
        : turn.end.status === "interrupted"
          ? "멈춤"
          : "응답이 끝나지 못했습니다"
      : turn.request
        ? "답을 기다리는 중"
        : "아직 대화가 없습니다";

  return (
    <section className={`drawer is-${mode}`} aria-label="대화 서랍">
      <div className="drawer-bar">
        <button type="button" className="drawer-summary" onClick={() => onMode(mode === "closed" ? "peek" : "closed")} aria-expanded={mode !== "closed"} title={mode === "closed" ? "마지막 답 보기" : "서랍 접기"}>
          <EngineMark provider={session.provider} size={14} />
          <span className={`drawer-state${busy ? " busy" : ""}${approvals.length ? " attention" : ""}`}>
            {busy && !approvals.length ? <span className="spinner small" /> : null}
            {approvals.length ? `확인 필요 ${approvals.length}` : state_}
          </span>
          {mode === "closed" && turn.answer ? <span className="drawer-line">{firstLine(turn.answer)}</span> : null}
          <Icon name={mode === "closed" ? "chevronUp" : "chevronDown"} size={14} />
        </button>
        <button type="button" className="text-button drawer-open" onClick={() => onMode(mode === "open" ? "peek" : "open")} title="대화 전체를 문서 위에 띄웁니다 (Esc로 닫기)">
          <Icon name="chat" size={14} /> {mode === "open" ? "대화 닫기" : "대화 전체"}
        </button>
        <button type="button" className="text-button" onClick={onOpenConversation} title="대화 화면으로 (문서는 탭에 남습니다)">
          대화로 ↗
        </button>
      </div>
      {mode === "peek" ? (
        <div className="drawer-peek">
          {approvals.map((approval) => (
            <div key={approval.id} className="drawer-approval" role="alert">
              <div className="drawer-approval-text">
                <strong>{approval.title}</strong>
                {approval.detail ? <code>{approval.detail}</code> : null}
              </div>
              <button type="button" className="button small" onClick={() => onAnswer(approval.id, "decline")}>
                거절
              </button>
              <button type="button" className="button primary small" onClick={() => onAnswer(approval.id, "accept")}>
                허용
              </button>
            </div>
          ))}
          {turn.request ? (
            <div className="drawer-request" title={turn.request.text}>
              <span className="drawer-label">요청</span> {firstLine(turn.request.text)}
            </div>
          ) : null}
          {turn.answer ? (
            <div className="drawer-answer">
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]} components={busy ? undefined : DRAWN}>
                  {folded && !whole ? folded : turn.answer}
                </Markdown>
              </div>
              {folded ? (
                <button type="button" className="link" onClick={() => setWhole(!whole)}>
                  {whole ? "요점만" : "답 전체"}
                </button>
              ) : null}
            </div>
          ) : busy ? (
            <div className="drawer-wait">{PROVIDER_LABEL[session.provider]}가 {statusText(session)}…</div>
          ) : null}
          {turn.proposals.map((item) => {
            const proposal = state.proposals[item.proposalId] as Proposal | undefined;
            return proposal ? <ProposalCard key={item.id} proposal={proposal} /> : null;
          })}
        </div>
      ) : null}
    </section>
  );
}

/** The whole conversation laid over the document while it stays where it is (Esc closes). */
export function ConversationSheet({ state, session, onClose, onAnswer }: { state: State; session: Session; onClose: () => void; onAnswer: (itemId: string, decision: "accept" | "decline") => void }) {
  // Esc closes the sheet, and only that: caught first (capture) so the conversation's own Esc
  // ("decline the waiting approval") never sees it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (event.target as HTMLElement).closest("textarea, input")) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const transcript = state.transcripts[session.id];
  return (
    <div className="drawer-sheet" role="dialog" aria-label={`대화 · ${session.purpose}`}>
      <header className="drawer-sheet-head">
        <EngineMark provider={session.provider} size={15} />
        <span>
          {session.purpose} · {PROVIDER_LABEL[session.provider]}
        </span>
        <button type="button" className="icon-button small" onClick={onClose} aria-label="대화 닫기" title="닫기 (Esc)">
          <Icon name="x" size={14} />
        </button>
      </header>
      <Transcript
        sessionId={session.id}
        items={transcript?.items ?? []}
        provider={session.provider}
        running={session.status === "running" || session.status === "starting"}
        loading={!transcript}
        onAnswer={onAnswer}
      />
    </div>
  );
}
