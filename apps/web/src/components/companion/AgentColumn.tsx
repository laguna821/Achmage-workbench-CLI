import type { ReactNode } from "react";
import { PROVIDER_LABEL, type OfficeInteractionResponse, type Session } from "@workbench/contracts";
import { isBusy, turnRunning, type State } from "../../state.ts";
import { EngineMark } from "../EngineMark.tsx";
import { Icon } from "../Icon.tsx";
import { NoteTitle } from "../note/NoteTitle.tsx";
import { StatusProp } from "../note/ConversationHead.tsx";
import { RequestListButton } from "../right/OutlineList.tsx";
import { Transcript } from "../Transcript.tsx";
import { markMenuOrigin } from "../nav/focus.ts";

export type AgentKind = "document" | "web";
const KIND_LABEL: Record<AgentKind, string> = { document: "문서 AI", web: "웹 AI" };

/** "문서 AI · 강의안.md" / "웹 AI · 평가 루브릭 안내": whose conversation the column is. */
export const agentTitle = (kind: AgentKind, name: string) => `${KIND_LABEL[kind]} · ${name}`;

/**
 * A document's or web page's own AI as a conversation column: the same note head, Transcript and
 * input zone as the main conversation. Its head names whose it is; `children` is its input zone
 * (the composer, or the line that stands in its place), always directly under its transcript.
 */
export function AgentColumn({ state, session, kind, name, onClose, onMenu, onOpenParent, onAnswer, focusItem, onFocusDone, readOnly = false, waiting, inputClass, children }: {
  state: State;
  /** The conversation shown; null while it is being prepared, or when the document has none. */
  session: Session | null;
  kind: AgentKind;
  /** The file or page it belongs to. */
  name: string;
  onClose: () => void;
  /** The conversation's own actions (rename, archive, mute, schedule…). */
  onMenu?: (session: Session, x: number, y: number) => void;
  /** Open the conversation this AI was started from. */
  onOpenParent?: (parent: Session) => void;
  onAnswer: (session: Session, itemId: string, decision: "accept" | "decline", response?: OfficeInteractionResponse) => void;
  focusItem?: { itemId: string; nonce: number } | null;
  onFocusDone?: () => void;
  /** Nothing is answered here (an archived conversation). */
  readOnly?: boolean;
  /** What to say while there is no conversation to show. */
  waiting?: string;
  /** A class the input zone is found by. */
  inputClass?: string;
  children: ReactNode;
}) {
  const transcript = session ? state.transcripts[session.id] : undefined;
  const parentId = session?.documentAgent?.parentSessionId ?? session?.pageAgent?.parentSessionId ?? null;
  const parent = parentId ? state.sessions[parentId] : undefined;
  const title = agentTitle(kind, name);
  const close = (
    <button type="button" className="icon-button small agent-close" aria-label={`${KIND_LABEL[kind]} 대화 닫기`} title="대화 닫기" onClick={onClose}>
      <Icon name="x" size={16} />
    </button>
  );
  const menu = session && onMenu ? (
    <button type="button" className="icon-button small note-head-more" aria-label={`이 ${KIND_LABEL[kind]} 메뉴`} title="이름 바꾸기·보관·알림 등" aria-haspopup="menu"
      onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); markMenuOrigin(event.currentTarget); onMenu(session, box.left, box.bottom + 4); }}>
      <Icon name="dots" size={16} />
    </button>
  ) : null;
  // An archived conversation is said to be one (its last status is not what it is doing).
  const status = session ? (session.archivedAt ? <span className="note-prop agent-archived">보관됨</span> : <StatusProp session={session} />) : null;
  const head = (
    <header className="note-head" data-kind="agent">
      <NoteTitle
        icon="chat"
        hook="agent-title"
        title={title}
        tools={<>{session ? <RequestListButton sessionId={session.id} items={transcript?.items} running={turnRunning(session)} /> : null}{menu}{close}</>}
      />
      <ul className="note-props" aria-label="속성">
        {parent && onOpenParent ? (
          <li>
            <button type="button" className="note-prop agent-parent" title="원래 대화 열기" onClick={() => onOpenParent(parent)}>
              <Icon name="arrowLeft" size={14} /><span>{parent.purpose}</span>
            </button>
          </li>
        ) : null}
        {session ? <li><span className="note-prop"><EngineMark provider={session.provider} size={14} /><span>{PROVIDER_LABEL[session.provider]}</span></span></li> : null}
        {status ? <li>{status}</li> : null}
      </ul>
    </header>
  );
  return (
    <div className="agent-column" data-agent={kind} data-session={session?.id}>
      {session ? (
        <Transcript
          head={head}
          band={{ title, tail: <>{status}{menu}{close}</> }}
          sessionId={session.id}
          items={transcript?.items ?? []}
          provider={session.provider}
          running={isBusy(session)}
          loading={!transcript}
          readOnly={readOnly}
          onAnswer={(itemId, decision, response) => onAnswer(session, itemId, decision, response)}
          focusItem={focusItem ?? null}
          onFocusDone={onFocusDone}
        />
      ) : (
        <div className="transcript">
          <div className="column transcript-inner">
            {head}
            {waiting ? <div className="empty-hint" role="status">{waiting}</div> : null}
          </div>
        </div>
      )}
      <div className={`column composer-area agent-input${inputClass ? ` ${inputClass}` : ""}`}>{children}</div>
    </div>
  );
}
