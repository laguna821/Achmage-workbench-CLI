import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { REMARK_BASE } from "../markdown/plugins.ts";
import { PROVIDER_LABEL, turnEndText, type MessageMedia, type Provider, type TranscriptItem } from "@workbench/contracts";
import { FileCard, HandoffCard, ProposalCard, RefChips, useDocs } from "./DocCards.tsx";
import { CREATE_LABEL } from "@workbench/contracts";
import { Icon, type IconName } from "./Icon.tsx";
import { diagramComponents } from "./Diagram.tsx";
import { AttachmentStrip, MessageImage } from "./Attachments.tsx";
import { PlanApproval } from "./PlanFirst.tsx";
import { OfficeQuestion } from "./OfficeQuestion.tsx";
import { ImageCard } from "./ImageGen.tsx";
import { LinkEndCard, LinkHopBadge, LinkRequestText } from "./LinkCards.tsx";
import { NoteChips } from "./pkm/NoteChips.tsx";
import { MessageActions } from "./pkm/MessageActions.tsx";
import { RequestText } from "./note/RequestText.tsx";
import { captureReadingAnchor, nearTranscriptEnd, readingAnchorTop, type ChatPosition, type ReadingAnchor } from "../conversation/reading-anchor.ts";
import { firstLine, registerNoteTarget, setReadingAt } from "../conversation/outline.ts";
import { approvalKeyApplies } from "../conversation/approval-keys.ts";

const DRAWN = diagramComponents();
const STREAMING = diagramComponents(true);

type Item<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>;

/** What folds into one "실행 상세" line: tool calls, reasoning, and a plan once every step is done. */
type Step = Item<"tool"> | Item<"reasoning"> | Item<"plan">;
const planDone = (item: Item<"plan">) => item.steps.length > 0 && item.steps.every((step) => step.status === "completed");

type Block =
  | { type: "user"; item: Item<"user"> }
  | { type: "assistant"; item: Item<"assistant"> }
  | { type: "work"; id: string; items: Step[] }
  | { type: "approval"; item: Item<"approval"> }
  | { type: "plan"; item: Item<"plan"> }
  | { type: "notice"; item: Item<"notice"> }
  | { type: "artifact"; item: Item<"artifact"> }
  | { type: "proposal"; item: Item<"proposal"> }
  | { type: "handoff"; item: Item<"handoff"> }
  | { type: "image"; item: Item<"image"> }
  | { type: "link"; item: Item<"link"> }
  | { type: "turnEnd"; item: Item<"turnEnd"> };

/**
 * Group consecutive tool calls and reasoning into one folded block, Codex-style. A finished plan
 * joins them (it was a step of the work); a plan still running stands open on its own.
 */
export function toBlocks(items: TranscriptItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user":
        blocks.push({ type: "user", item });
        break;
      case "assistant":
        if (!item.text.trim() && !item.streaming) break;
        blocks.push({ type: "assistant", item });
        break;
      case "tool":
      case "reasoning":
      case "plan": {
        if (item.kind === "reasoning" && !item.text.trim()) break;
        if (item.kind === "plan" && !planDone(item)) {
          blocks.push({ type: "plan", item });
          break;
        }
        const last = blocks[blocks.length - 1];
        if (last?.type === "work") {
          last.items.push(item);
        } else {
          blocks.push({ type: "work", id: `work:${item.id}`, items: [item] });
        }
        break;
      }
      case "approval":
        blocks.push({ type: "approval", item });
        break;
      case "notice":
        blocks.push({ type: "notice", item });
        break;
      case "artifact":
        blocks.push({ type: "artifact", item });
        break;
      case "proposal":
        blocks.push({ type: "proposal", item });
        break;
      case "handoff":
        blocks.push({ type: "handoff", item });
        break;
      case "image":
        blocks.push({ type: "image", item });
        break;
      case "link":
        blocks.push({ type: "link", item });
        break;
      case "turnEnd":
        blocks.push({ type: "turnEnd", item });
        break;
    }
  }
  return blocks;
}

const TOOL_ICON: Record<string, IconName> = {
  command: "terminal",
  fileChange: "edit",
  search: "search",
  web: "globe",
  mcp: "tool",
  agent: "tool",
  other: "tool",
};

const AssistantText = memo(function AssistantText({ text, streaming, media = [] }: { text: string; streaming: boolean; media?: MessageMedia[] }) {
  const gallery = media.map(entry => entry.attachment);
  return (
    <div className={`markdown${streaming ? " streaming" : ""}`}>
      <Markdown remarkPlugins={REMARK_BASE} urlTransform={(url, key) => key === "src" ? url : defaultUrlTransform(url)} components={{ ...(streaming ? STREAMING : DRAWN), img: ({ src, alt }) => {
        const saved = media.find(entry => entry.source === src);
        return saved ? <MessageImage attachment={saved.attachment} gallery={gallery} />
          : <span className="muted">{alt || "그림"}{typeof src === "string" && /^https?:\/\//i.test(src) ? <> · <a href={src} target="_blank" rel="noreferrer">원본 링크</a></> : streaming ? " · 응답 후 미리보기" : " · 미리보기 없음"}</span>;
      } }}>
        {text || " "}
      </Markdown>
    </div>
  );
});

function workSummary(items: Step[]) {
  const tools = items.filter((item): item is Item<"tool"> => item.kind === "tool");
  const running = tools.find((tool) => tool.status === "running");
  if (running) return { text: running.title, running: true };
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.tool, (counts.get(tool.tool) ?? 0) + 1);
  const parts: string[] = [];
  for (const plan of items) if (plan.kind === "plan") parts.push(`계획 ${plan.steps.length}/${plan.steps.length}`);
  if (counts.get("command")) parts.push(`명령 ${counts.get("command")}개`);
  if (counts.get("fileChange")) parts.push(`파일 변경 ${counts.get("fileChange")}건`);
  const other = tools.length - (counts.get("command") ?? 0) - (counts.get("fileChange") ?? 0);
  if (other) parts.push(`도구 ${other}개`);
  if (!parts.length) parts.push("생각 정리");
  return { text: parts.join(" · "), running: false };
}

function ToolRow({ item, focused }: { item: Item<"tool">; focused: boolean }) {
  const [open, setOpen] = useState(focused);
  useLayoutEffect(() => { if (focused) setOpen(true); }, [focused]);
  const hasBody = Boolean(item.output || (item.detail && item.tool !== "command"));
  return (
    <li className={`tool-row status-${item.status}`} data-item-id={item.id}>
      <button type="button" className="tool-row-head" onClick={() => hasBody && setOpen(!open)} aria-expanded={hasBody ? open : undefined} aria-label={`${item.title} · ${item.status === "running" ? "실행 중" : item.status === "completed" ? "완료" : item.status === "declined" ? "거절됨" : item.status === "unknown" ? "기록에 결과 없음" : "실패"}`}>
        <Icon name={TOOL_ICON[item.tool] ?? "tool"} size={14} className="tool-icon" />
        <span className={item.tool === "command" ? "tool-title mono" : "tool-title"}>{item.title}</span>
        <span className="tool-status">
          {item.status === "running" ? <span className="spinner" aria-label="실행 중" /> : item.status === "completed" ? <Icon name="check" size={14} /> : item.status === "declined" ? "거절됨" : item.status === "unknown" ? "기록에 결과 없음" : "실패"}
        </span>
      </button>
      {open && hasBody ? (
        <pre className="tool-output">{[item.tool !== "command" ? item.detail : null, item.output].filter(Boolean).join("\n\n")}</pre>
      ) : null}
    </li>
  );
}

function WorkBlock({ block, focusItemId }: { block: Extract<Block, { type: "work" }>; focusItemId?: string }) {
  const focused = block.items.some(item => item.id === focusItemId);
  const [open, setOpen] = useState(focused);
  useLayoutEffect(() => { if (focused) setOpen(true); }, [focused]);
  const summary = workSummary(block.items);
  const problems = block.items.filter((item): item is Item<"tool"> => item.kind === "tool" && (item.status === "failed" || item.status === "declined"));
  // Pictures the steps made or looked at stay in view while the steps are folded (Codex app).
  const images = block.items
    .flatMap((item) => (item.kind === "tool" ? (item.images ?? []) : []))
    .filter((image, index, all) => all.findIndex((other) => other.id === image.id) === index);
  return (
    <>
    <div className="work-block note-callout">
      <button type="button" className="note-callout-head work-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <span className={summary.running ? "work-summary-text running" : "work-summary-text"}>실행 상세 · {summary.text}</span>
        {summary.running ? <span className="spinner" /> : null}
      </button>
      {!open && problems.length ? <div className="work-problems" role="status">{problems.map(item => <button key={item.id} type="button" className="text-button" onClick={() => setOpen(true)}>{item.status === "declined" ? "거절됨" : "실패"} · {item.title}</button>)}</div> : null}
      {open || focused ? (
        <ul className="work-list">
          {block.items.map((item) =>
            item.kind === "tool" ? (
              <ToolRow key={item.id} item={item} focused={item.id === focusItemId} />
            ) : item.kind === "plan" ? (
              <li key={item.id} className="plan-row" data-item-id={item.id}>
                <PlanSteps item={item} />
              </li>
            ) : (
              <li key={item.id} className="reasoning-row" data-item-id={item.id}>
                {item.text}
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
    {images.length ? <AttachmentStrip attachments={images} /> : null}
    </>
  );
}

function ApprovalCard({ item, onAnswer, onTrust, readOnly = false }: { item: Item<"approval">; onAnswer: (decision: "accept" | "decline", response?: import("@workbench/contracts").OfficeInteractionResponse) => void; onTrust?: () => void; readOnly?: boolean }) {
  // An archived conversation answers nothing: what waited is shown, without its answers.
  if (readOnly && item.decision === null) {
    return (
      <div className="approval-card" role="note">
        <div className="approval-title">{item.title}</div>
        {item.detail ? <pre className="approval-detail">{item.detail}</pre> : null}
        <div className="approval-reason">답하지 않은 채 보관했습니다. 대화를 되돌리면 답할 수 있습니다.</div>
      </div>
    );
  }
  if (item.officeInteraction) return <OfficeQuestion item={item} onAnswer={onAnswer} />;
  if (item.plan) return <PlanApproval item={item} onAnswer={onAnswer} />;
  if (item.decision !== null) {
    const label = item.decision === "accept" ? "허용함" : item.decision === "decline" ? "거절함" : "응답 없이 지나감";
    return (
      <div className="approval-done">
        <Icon name={item.decision === "accept" ? "check" : "x"} size={14} />
        <span>{label}</span>
        {item.detail ? <span className="mono approval-done-detail">{item.detail}</span> : null}
      </div>
    );
  }
  return (
    <div className="approval-card" role="alert">
      <div className="approval-title">{item.title}</div>
      {item.detail ? <pre className="approval-detail">{item.detail}</pre> : null}
      {item.reason ? <div className="approval-reason">{item.reason}</div> : null}
      <div className="approval-actions">
        {onTrust ? (
          <button type="button" className="text-button approval-trust" onClick={onTrust} title="이 세션은 앞으로 묻지 않고 진행합니다(전체 접근). 입력창 아래 권한에서 다시 바꿀 수 있습니다.">
            <Icon name="unlock" size={14} /> 앞으로 묻지 않기
          </button>
        ) : null}
        <div className="approval-decisions">
        <button type="button" className="button" onClick={() => onAnswer("decline")}>
          거절 <kbd>Esc</kbd>
        </button>
        <button type="button" className="button primary" onClick={() => onAnswer("accept")}>
          허용 <kbd>Enter</kbd>
        </button>
        </div>
      </div>
    </div>
  );
}

function PlanSteps({ item }: { item: Item<"plan"> }) {
  return (
    <ol className="plan-steps">
      {item.steps.map((step, index) => (
        <li key={index} className={`plan-step ${step.status}`}>
          <span className="plan-mark">{step.status === "completed" ? <Icon name="check" size={13} /> : step.status === "inProgress" ? <span className="spinner small" /> : null}</span>
          <span>{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** A plan still running: an open callout (finished, it folds into the steps around it). */
function PlanCard({ item }: { item: Item<"plan"> }) {
  const done = item.steps.filter((step) => step.status === "completed").length;
  const [open, setOpen] = useState(true);
  return (
    <div className="plan-card note-callout">
      <button type="button" className="note-callout-head plan-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <span>계획 · {done}/{item.steps.length}</span>
      </button>
      {open ? <PlanSteps item={item} /> : null}
    </div>
  );
}

type Turn = { id: string; index: number; user: Item<"user"> | null; blocks: Block[]; end: Item<"turnEnd"> | null; attention: boolean; after: Block[] };

/** A turn is one request and everything the engine did for it. */
function toTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  let index = 0;
  for (const block of blocks) {
    if (block.type === "user" || !turns.length) {
      if (block.type === "user") index += 1;
      turns.push({ id: block.type === "user" ? block.item.id : "start", index, user: block.type === "user" ? block.item : null, blocks: [], end: null, attention: false, after: [] });
      if (block.type === "user") continue;
    }
    const turn = turns[turns.length - 1];
    if (block.type === "turnEnd") turn.end = block.item;
    // A linked-session end card goes below the turn's end line (also when the turn was stopped by it).
    else if (block.type === "link") turn.after.push(block);
    else turn.blocks.push(block);
    if (block.type === "approval" && block.item.decision === null) turn.attention = true;
  }
  return turns;
}

const clock = (at: number) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

function duration(ms: number | null) {
  if (!ms) return null;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

const PIN_OPEN_KEY = "workbench.pinOpen";
/** Where each conversation was read, while it is shown again after another view (mode switches). */
const readAt = new Map<string, { top: number; anchor?: ReadingAnchor }>();
/** Height of the folded request band; the band appears once the request slides under it. */
const PIN_HEIGHT = 46;

/**
 * A request as a block of the note: its number, the words (folded when long), what came with it
 * (always in view, pictures as thumbnails); the time and its tags on the right. Same left edge as
 * the answers; no bubble. Memoised on the item: it never re-renders while a later answer streams.
 */
const RequestBlock = memo(function RequestBlock({ index, user, reveal, onFork, onOpenSession }: { index: number; user: Item<"user">; reveal: number; onFork?: (itemId: string) => void; onOpenSession: (sessionId: string) => void }) {
  const kind = user.link ? (user.link.fromSessionId ? "받은 답" : "목표") : user.peer ? "받은 메시지" : "요청";
  return (
    <article className={`turn-request${user.link || user.peer ? " received" : ""}`} aria-label={`${kind} ${index}`} data-item-id={user.id} data-reading-id={user.id}>
      <span className="turn-no" aria-hidden>{index}</span>
      <div className="request-main">
        {user.from ? (
          <button type="button" className="from-badge" onClick={() => user.from && onOpenSession(user.from.sessionId)}>
            <Icon name="arrowLeft" size={12} /> {user.from.label}에서 온 요청
          </button>
        ) : null}
        {user.peer ? (
          <span className="from-badge peer-badge" title={user.peer.from ? `보낸 세션: ${user.peer.from} (보낸 쪽이 밝힌 이름)` : undefined}>
            <Icon name="arrowLeft" size={12} /> 다른 세션에서 온 메시지{user.peer.name ? ` · ${user.peer.name}` : ""}
          </span>
        ) : null}
        {user.link ? <LinkHopBadge hop={user.link} /> : null}
        {user.link?.fromSessionId ? <LinkRequestText text={user.text} reveal={reveal} /> : <RequestText text={user.text} reveal={reveal} />}
        {user.attachments?.length ? <AttachmentStrip attachments={user.attachments} /> : null}
        {user.refs?.length ? <RefChips refs={user.refs} /> : null}
        {user.notes?.length ? <NoteChips notes={user.notes} /> : null}
        {user.create ? (
          <div className="ref-chips">
            <span className="ref-chip create-chip" title={user.create.path}>
              → 새 {CREATE_LABEL[user.create.format]}: {user.create.name}
            </span>
          </div>
        ) : null}
      </div>
      <div className="request-side">
        {user.plan ? <span className="request-tag plan-tag">계획 먼저</span> : null}
        {user.scheduled ? <span className="request-tag scheduled-tag" title="예약 작업으로 보낸 요청">예약</span> : null}
        {user.origin ? <span className="request-tag phone-tag" title="휴대폰 메신저에서 보낸 요청">휴대폰</span> : null}
        {user.undelivered ? (
          <span className="request-tag steer-tag undelivered" title="멈춰서 엔진에 전해지지 않았습니다. 입력창 위 목록에서 다시 보낼 수 있습니다.">전해지지 않음</span>
        ) : user.steered ? (
          <span className="request-tag steer-tag" title="응답하는 중에 보내 하던 작업에 전한 요청">작업 중 보냄</span>
        ) : null}
        {user.draw ? <span className="request-tag draw-tag" title="GPT Image로 그린 요청">그림{user.draw.template ? ` · ${user.draw.template}` : ""}</span> : null}
        {onFork && !user.link && !user.peer ? (
          <button type="button" className="icon-button small fork-button" onClick={() => onFork(user.id)} aria-label="이 요청 전으로"
            title="이 요청 전으로 · 이 요청 앞까지의 대화로 새 갈래를 만들고, 이 요청을 고쳐 다시 묻습니다(이 대화는 그대로)">
            <Icon name="restore" size={14} />
          </button>
        ) : null}
        <time className="request-time" dateTime={new Date(user.at).toISOString()}>{clock(user.at)}</time>
      </div>
    </article>
  );
});

export function Transcript({
  sessionId,
  items,
  provider,
  running,
  loading,
  onAnswer,
  onTrust,
  onFork,
  focusItem,
  onFocusDone,
  position,
  onPosition,
  head,
  band,
  readOnly = false,
}: {
  /** An archived conversation: nothing is answered here (no approvals, by click or key). */
  readOnly?: boolean;
  /** The note's head (inline title and properties): the first thing in the reading column. */
  head?: ReactNode;
  /** While the head is out of view, the pinned band says the title (when no request is pinned) and carries `tail` at its end. */
  band?: { title: string; tail: ReactNode };
  position?: ChatPosition;
  onPosition?: (position: ChatPosition) => void;
  sessionId: string;
  items: TranscriptItem[];
  provider: Provider;
  running: boolean;
  loading: boolean;
  onAnswer: (itemId: string, decision: "accept" | "decline", response?: import("@workbench/contracts").OfficeInteractionResponse) => void;
  /** "앞으로 묻지 않기": full access for this session (answers what waits, too). */
  onTrust?: () => void;
  /** "이 요청 전으로": a new session with the conversation up to this request, the request to edit. */
  onFork?: (itemId: string) => void;
  /** Bring this message into view and mark it for a moment (a search hit). */
  focusItem?: { itemId: string; nonce: number } | null;
  onFocusDone?: () => void;
}) {
  const { state, actions: docActions } = useDocs();
  const scroller = useRef<HTMLDivElement>(null);
  // Follow the newest output only while the reader is at the bottom. Any move up (wheel, keys, the
  // scroll bar, touch) stops following at once; scrolling back down to the end resumes it.
  const pinned = useRef(position?.follow ?? true);
  const restorePending = useRef<number | null>(position && !position.follow ? position.top : null);
  const ownTop = useRef<number | null>(null);
  const lastTop = useRef(0);
  const readingAnchor = useRef<ReadingAnchor | null>(position?.anchor ?? null);
  const reconcileLayout = useRef<() => void>(() => undefined);
  const flashTarget = useRef<{ element: HTMLElement; timer: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [pinOpen, setPinOpen] = useState(() => localStorage.getItem(PIN_OPEN_KEY) === "1");
  const sections = useRef(new Map<string, HTMLElement>());
  const blocks = useMemo(() => toBlocks(items), [items]);
  const turns = useMemo(() => toTurns(blocks), [blocks]);
  const pending = items.find((item): item is Item<"approval"> => item.kind === "approval" && item.decision === null);
  // The engine is working but nothing has arrived since the last request yet.
  const waitingFirst = running && blocks[blocks.length - 1]?.type === "user";
  const [sticky, setSticky] = useState<Turn | null>(null);
  const [headGone, setHeadGone] = useState(false);
  // A request a search hit or a jump lands in opens its folded words: every time (a new nonce per
  // event), also after the reader folded it again.
  const [revealed, setRevealed] = useState<{ id: string; nonce: number } | null>(null);
  const reveal = (id: string) => setRevealed((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }));
  // The search hit already opened (its nonce), so one hit opens once and the next one again.
  const revealedFor = useRef<number | null>(null);
  // Stable for the memoised request blocks: a streaming answer must not re-render earlier requests.
  const forkRef = useRef(onFork);
  forkRef.current = onFork;
  const fork = useCallback((itemId: string) => forkRef.current?.(itemId), []);
  const openSessionRef = useRef(docActions.openSession);
  openSessionRef.current = docActions.openSession;
  const openSession = useCallback((id: string) => openSessionRef.current(id), []);

  // Which request the reader is inside: the pinned band, and the outline (right sidebar) as it
  // follows the reading. At the very end, the last request on screen counts even if it cannot
  // reach the top.
  const measure = () => {
    const element = scroller.current;
    if (!element) return;
    const top = element.scrollTop;
    const atEnd = nearTranscriptEnd(element);
    let current: Turn | null = null;
    let reading: Turn | null = null;
    for (const turn of turns) {
      const section = sections.current.get(turn.id);
      if (!section || !turn.user) continue;
      if (section.offsetTop <= top + 12) current = turn;
      if (section.offsetTop <= top + 12 || (atEnd && section.offsetTop < top + element.clientHeight)) reading = turn;
    }
    setReadingAt(`chat:${sessionId}`, reading?.id ?? null);
    const header = current ? sections.current.get(current.id)?.querySelector<HTMLElement>(".turn-request") : null;
    const section = current ? sections.current.get(current.id) : null;
    // Offsets are relative to the scroller (the positioned ancestor of both). The band takes over
    // once the request has slid under where the band sits, so it never pops up over the answer.
    // The trigger must not depend on the band that this state mounts. Dense layouts and
    // expanded requests have different heights; measuring that height toggled the band
    // on/off at the threshold until React hit its update-depth limit during a resize.
    const cover = PIN_HEIGHT;
    const headerGone = header ? header.offsetTop + header.offsetHeight < top + cover : false;
    const stillInside = section ? section.offsetTop + section.offsetHeight > top + cover + 48 : false;
    const nextSticky = current && headerGone && stillInside ? current : null;
    setSticky((previous) => (previous?.id === nextSticky?.id ? previous : nextSticky));
    const headElement = element.querySelector<HTMLElement>(".note-head");
    setHeadGone(Boolean(headElement) && headElement!.offsetTop + headElement!.offsetHeight < top + 4);
    setAtBottom(atEnd);
  };

  // Another session: start at its newest output again — or where the reader left it, when this
  // conversation comes back after another view.
  useLayoutEffect(() => {
    const element = scroller.current;
    const saved = position && !position.follow ? position : readAt.get(sessionId);
    const top = saved?.top;
    readingAnchor.current = saved?.anchor ?? null;
    restorePending.current = top ?? null;
    if (element && top !== undefined && !focusItem && element.scrollHeight - element.clientHeight >= top) {
      pinned.current = false;
      element.scrollTop = top;
      ownTop.current = element.scrollTop;
      lastTop.current = element.scrollTop;
      return;
    }
    pinned.current = top === undefined;
    lastTop.current = 0;
    // Only when the conversation changes (or first shows).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  reconcileLayout.current = () => {
    const element = scroller.current;
    if (!element || element.closest(".pane[hidden]")) return;
    if (element && restorePending.current !== null && !loading && !focusItem && element.clientHeight > 0) {
      const top = readingAnchor.current ? readingAnchorTop(element, readingAnchor.current) : null;
      element.scrollTop = Math.min(top ?? restorePending.current, Math.max(0, element.scrollHeight - element.clientHeight));
      ownTop.current = element.scrollTop; lastTop.current = element.scrollTop;
      pinned.current = false; restorePending.current = null;
    }
    // Moved since the last scroll event (a key, the scroll bar, a script; the event comes a frame
    // later): that is where the reader is now, not a layout shift to undo.
    if (!pinned.current && restorePending.current === null && Math.abs(element.scrollTop - lastTop.current) > 0.5) {
      lastTop.current = element.scrollTop;
      readingAnchor.current = captureReadingAnchor(element);
    }
    if (!pinned.current && readingAnchor.current && restorePending.current === null && !focusItem) {
      const top = readingAnchorTop(element, readingAnchor.current);
      if (top !== null && Math.abs(element.scrollTop - top) > 0.5) {
        element.scrollTop = top;
        ownTop.current = element.scrollTop;
        lastTop.current = element.scrollTop;
      }
    }
    if (element && pinned.current && !focusItem && element.scrollTop + element.clientHeight < element.scrollHeight - 1) {
      element.scrollTop = element.scrollHeight;
      // Remember where this put us: the scroll event it raises is ours, not the reader's.
      ownTop.current = element.scrollTop;
    }
    if (!loading && restorePending.current === null && element.clientHeight > 0) readingAnchor.current = captureReadingAnchor(element);
    measure();
  };
  useLayoutEffect(() => { reconcileLayout.current(); });

  // Image decode, nested tool disclosures and composer/viewport resizing can change geometry
  // without changing `items`. Apply the same message + offset anchor in every case.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const reconcile = () => reconcileLayout.current();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reconcile);
    observer?.observe(element);
    const content = element.querySelector(".transcript-inner");
    if (content) observer?.observe(content);
    window.addEventListener("resize", reconcile);
    element.addEventListener("load", reconcile, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", reconcile); element.removeEventListener("load", reconcile, true); };
  }, [sessionId]);

  // A search hit: scroll to that message once it is on screen, then mark it briefly.
  useEffect(() => () => {
    if (flashTarget.current) { window.clearTimeout(flashTarget.current.timer); flashTarget.current.element.classList.remove("flash"); }
  }, []);
  useEffect(() => {
    if (!focusItem || loading) return;
    const target = scroller.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(focusItem.itemId)}"]`);
    if (!target) return;
    // A hit inside folded words: open them first; this runs again once they are open.
    if (target.querySelector(".request-text .markdown.folded") && revealedFor.current !== focusItem.nonce) {
      revealedFor.current = focusItem.nonce;
      reveal(focusItem.itemId);
      return;
    }
    if (flashTarget.current) { window.clearTimeout(flashTarget.current.timer); flashTarget.current.element.classList.remove("flash"); }
    pinned.current = false;
    restorePending.current = null;
    target.scrollIntoView({ block: "center" });
    if (scroller.current) {
      ownTop.current = scroller.current.scrollTop;
      lastTop.current = scroller.current.scrollTop;
      readingAnchor.current = captureReadingAnchor(scroller.current);
    }
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
    const timer = window.setTimeout(() => { target.classList.remove("flash"); flashTarget.current = null; }, 2400);
    flashTarget.current = { element: target, timer };
    onFocusDone?.();
  }, [focusItem, loading, items.length, onFocusDone, revealed]);

  // Enter / Esc answer the pending approval (or plan), only from the page itself or from inside
  // this conversation away from controls: never a key meant for the sidebar, a menu, another pane.
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pending || pending.officeInteraction || readOnly) return;
    const onKey = (event: KeyboardEvent) => {
      if (!approvalKeyApplies(event, wrap.current)) return;
      if (event.key === "Enter") onAnswer(pending.id, "accept");
      else if (event.key === "Escape") onAnswer(pending.id, "decline");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onAnswer, readOnly]);

  const toTop = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = false;
    readingAnchor.current = null;
    element.scrollTo({ top: 0, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const jumpTo = (turnId: string) => {
    const section = sections.current.get(turnId);
    const element = scroller.current;
    if (!section || !element) return;
    pinned.current = false;
    readingAnchor.current = null;
    reveal(turnId);
    element.scrollTo({ top: section.offsetTop - 8, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  // The outline (right sidebar, a compact request list) jumps here with the same path.
  const jumpRef = useRef(jumpTo);
  jumpRef.current = jumpTo;
  useEffect(() => registerNoteTarget(`chat:${sessionId}`, { element: () => scroller.current, jump: (turnId) => jumpRef.current(turnId) }), [sessionId]);

  const toBottom = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    readingAnchor.current = null;
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    ownTop.current = element.scrollTop;
    onPosition?.({ top: element.scrollTop, follow: true });
  };

  const renderBlockContent = (block: Block) => {
    switch (block.type) {
      case "user":
        return null;
      case "assistant":
        return (
          <div key={block.item.id} className="turn-answer">
            <AssistantText text={block.item.text} streaming={block.item.streaming} media={block.item.media} />
            <MessageActions sessionId={sessionId} itemId={block.item.id} streaming={block.item.streaming} />
          </div>
        );
      case "work":
        return (
          <WorkBlock key={block.id} block={block} focusItemId={focusItem?.itemId} />
        );
      case "approval":
        return <ApprovalCard key={block.item.id} item={block.item} readOnly={readOnly} onAnswer={(decision, response) => onAnswer(block.item.id, decision, response)} onTrust={onTrust} />;
      case "plan":
        return <PlanCard key={block.item.id} item={block.item} />;
      case "notice":
        return (
          <div key={block.item.id} className={`notice notice-${block.item.level}`} role={block.item.level === "error" ? "alert" : "status"}>
            {block.item.text}
          </div>
        );
      case "artifact": {
        const artifact = state.artifacts[block.item.artifactId];
        return artifact ? <FileCard key={block.item.id} artifact={artifact} revision={block.item.revision} change={block.item.change} /> : null;
      }
      case "proposal": {
        const proposal = state.proposals[block.item.proposalId];
        return proposal ? <ProposalCard key={block.item.id} proposal={proposal} /> : null;
      }
      case "handoff": {
        const handoff = state.handoffs[block.item.handoffId];
        return handoff ? <HandoffCard key={block.item.id} handoff={handoff} viewer={sessionId} /> : null;
      }
      case "image":
        return <ImageCard key={block.item.id} item={block.item} viewer={sessionId} />;
      case "link":
        return <LinkEndCard key={block.item.id} linkId={block.item.linkId} />;
      case "turnEnd":
        return null;
    }
  };
  const renderBlock = (block: Block) => {
    const id = block.type === "work" ? block.id : block.item.id;
    return <div key={id} className="transcript-block" data-reading-id={id} data-item-id={block.type === "work" ? undefined : id}>{renderBlockContent(block)}</div>;
  };

  return (
    <div className="transcript-wrap" ref={wrap} data-screen="S03" data-follow-output={pinned.current}>
      <div
        className="transcript"
        role="region"
        aria-label={`${PROVIDER_LABEL[provider]} 대화`}
        aria-busy={loading}
        tabIndex={0}
        ref={scroller}
        onClickCapture={() => { if (scroller.current && !pinned.current) readingAnchor.current = captureReadingAnchor(scroller.current); }}
        onWheel={(event) => {
          // Wheel inside the opened band scrolls the band, not the conversation.
          if (event.deltaY < 0 && !(event.target as HTMLElement).closest(".turn-pin")) pinned.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "PageUp" || event.key === "ArrowUp" || event.key === "Home") pinned.current = false;
        }}
        onTouchMove={() => {
          pinned.current = false;
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.closest(".pane[hidden]")) return;
          const top = element.scrollTop;
          const own = ownTop.current !== null && Math.abs(top - ownTop.current) < 1;
          ownTop.current = null;
          if (!own) {
            if (nearTranscriptEnd(element)) pinned.current = true;
            else if (top < lastTop.current - 0.5) pinned.current = false;
          }
          lastTop.current = top;
          readingAnchor.current = captureReadingAnchor(element);
          if (pinned.current) readAt.delete(sessionId);
          else readAt.set(sessionId, { top, ...(readingAnchor.current ? { anchor: readingAnchor.current } : {}) });
          if (restorePending.current === null) onPosition?.({ top, follow: pinned.current, ...(readingAnchor.current ? { anchor: readingAnchor.current } : {}) });
          measure();
        }}
      >
        <div className="turn-pin-slot">
          {sticky?.user || (headGone && band) ? (
            <div className={`turn-pin${pinOpen && sticky?.user ? " open" : ""}`}>
              <div className="column turn-pin-inner">
                {sticky?.user ? (
                  <>
                    <button type="button" className="turn-pin-main" onClick={() => jumpTo(sticky.id)} title="이 요청으로 올라가기">
                      <span className="turn-no">{sticky.index}</span>
                      {pinOpen ? null : <span className="turn-pin-text">{firstLine(sticky.user.text)}</span>}
                    </button>
                    {pinOpen ? (
                      <div className="turn-pin-full">
                        <RequestText text={sticky.user.text} fold={false} />
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="icon-button small turn-pin-toggle"
                      onClick={() => {
                        setPinOpen(!pinOpen);
                        localStorage.setItem(PIN_OPEN_KEY, pinOpen ? "0" : "1");
                      }}
                      aria-expanded={pinOpen}
                      title={pinOpen ? "요청 접기" : "요청 전체 보기"}
                      aria-label={pinOpen ? "요청 접기" : "요청 전체 보기"}
                    >
                      <Icon name={pinOpen ? "chevronUp" : "chevronDown"} size={15} />
                    </button>
                  </>
                ) : (
                  <button type="button" className="turn-pin-main turn-pin-title" onClick={toTop} title="맨 위(제목)로">
                    <span className="turn-pin-text">{band!.title}</span>
                  </button>
                )}
                {headGone && band ? <div className="turn-pin-tail">{band.tail}</div> : null}
              </div>
            </div>
          ) : null}
        </div>
        <div className="column transcript-inner">
          {head}
          {loading ? <div className="empty-hint" role="status">대화를 불러오는 중…</div> : null}
          {!loading && !blocks.length ? <div className="empty-hint">이 세션에 요청을 보내면 여기에 대화가 이어집니다.</div> : null}
          {turns.map((turn, position) => (
            <section
              key={turn.id}
              className="turn"
              ref={(element) => {
                if (element) sections.current.set(turn.id, element);
                else sections.current.delete(turn.id);
              }}
            >
              {turn.user ? <RequestBlock index={turn.index} user={turn.user} reveal={revealed?.id === turn.user.id ? revealed.nonce : 0} onFork={onFork ? fork : undefined} onOpenSession={openSession} /> : null}
              <div className="turn-body">
                {turn.blocks.map(renderBlock)}
                {waitingFirst && position === turns.length - 1 ? (
                  <div className="turn-answer">
                    <div className="response-pending" role="status" aria-label="응답을 기다리는 중">
                      <span className="response-pending-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
              {turn.end ? (
                <div className={`turn-end turn-end-${turn.end.status}`} data-item-id={turn.end.id} data-reading-id={turn.end.id}>
                  {turn.end.status === "completed" ? <Icon name="check" size={13} /> : null}
                  {turnEndText(turn.end)}
                  {duration(turn.end.durationMs) ? <span className="muted"> · {duration(turn.end.durationMs)}</span> : null}
                </div>
              ) : null}
              {turn.after.map(renderBlock)}
            </section>
          ))}
        </div>
      </div>
      {/* Back to the newest output: a band of its own under the conversation, the button inside the
          reading column — it ends the scroll area there instead of floating over the words. */}
      {!atBottom ? (
        <div className="jump-band">
          <div className="jump-band-inner">
            <button type="button" className="jump-end" onClick={toBottom} title="맨 아래로">
              <Icon name="chevronDown" size={15} /> {running ? "새 응답 보기" : "맨 아래로"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
