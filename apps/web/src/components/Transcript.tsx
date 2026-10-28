import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PROVIDER_LABEL, type Provider, type TranscriptItem } from "@workbench/contracts";
import { EngineMark } from "./EngineMark.tsx";
import { FileCard, HandoffCard, ProposalCard, RefChips, useDocs } from "./DocCards.tsx";
import { CREATE_LABEL } from "@workbench/contracts";
import { Icon, type IconName } from "./Icon.tsx";
import { diagramComponents } from "./Diagram.tsx";
import { LinkEndCard, LinkHopBadge, LinkRequestText } from "./LinkCards.tsx";

const DRAWN = diagramComponents();
const STREAMING = diagramComponents(true);

type Item<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>;

type Block =
  | { type: "user"; item: Item<"user"> }
  | { type: "assistant"; item: Item<"assistant">; speaker: boolean }
  | { type: "work"; id: string; items: (Item<"tool"> | Item<"reasoning">)[]; speaker: boolean }
  | { type: "approval"; item: Item<"approval"> }
  | { type: "plan"; item: Item<"plan"> }
  | { type: "notice"; item: Item<"notice"> }
  | { type: "artifact"; item: Item<"artifact"> }
  | { type: "proposal"; item: Item<"proposal"> }
  | { type: "handoff"; item: Item<"handoff"> }
  | { type: "link"; item: Item<"link"> }
  | { type: "turnEnd"; item: Item<"turnEnd"> };

/** Group consecutive tool calls and reasoning into one folded block, Codex-style. */
export function toBlocks(items: TranscriptItem[]): Block[] {
  const blocks: Block[] = [];
  let speakerShown = false;
  for (const item of items) {
    switch (item.kind) {
      case "user":
        blocks.push({ type: "user", item });
        speakerShown = false;
        break;
      case "assistant":
        if (!item.text.trim() && !item.streaming) break;
        blocks.push({ type: "assistant", item, speaker: !speakerShown });
        speakerShown = true;
        break;
      case "tool":
      case "reasoning": {
        if (item.kind === "reasoning" && !item.text.trim()) break;
        const last = blocks[blocks.length - 1];
        if (last?.type === "work") {
          last.items.push(item);
        } else {
          blocks.push({ type: "work", id: `work:${item.id}`, items: [item], speaker: !speakerShown });
          speakerShown = true;
        }
        break;
      }
      case "approval":
        blocks.push({ type: "approval", item });
        break;
      case "plan":
        blocks.push({ type: "plan", item });
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

const AssistantText = memo(function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className={`markdown${streaming ? " streaming" : ""}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={streaming ? STREAMING : DRAWN}>
        {text || " "}
      </Markdown>
    </div>
  );
});

type MdNode = { type: string; value?: string; children?: MdNode[] };

/**
 * A line break typed in a request stays a line break (chat, not a document: Markdown would join
 * the lines). Code keeps its own lines anyway.
 */
function remarkLineBreaks() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && child.value?.includes("\n")) {
        child.value.split("\n").forEach((part, index) => {
          if (index > 0) next.push({ type: "break" });
          if (part) next.push({ type: "text", value: part });
        });
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}

/** What the user typed, read as Markdown (headings, lists, code, tables), line breaks kept. */
const RequestText = memo(function RequestText({ text }: { text: string }) {
  return (
    <div className="user-bubble markdown">
      <Markdown remarkPlugins={[remarkGfm, remarkLineBreaks]} components={DRAWN}>
        {text}
      </Markdown>
    </div>
  );
});

function workSummary(items: (Item<"tool"> | Item<"reasoning">)[]) {
  const tools = items.filter((item): item is Item<"tool"> => item.kind === "tool");
  const running = tools.find((tool) => tool.status === "running");
  if (running) return { text: running.title, running: true };
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.tool, (counts.get(tool.tool) ?? 0) + 1);
  const parts: string[] = [];
  if (counts.get("command")) parts.push(`명령 ${counts.get("command")}개`);
  if (counts.get("fileChange")) parts.push(`파일 변경 ${counts.get("fileChange")}건`);
  const other = tools.length - (counts.get("command") ?? 0) - (counts.get("fileChange") ?? 0);
  if (other) parts.push(`도구 ${other}개`);
  if (!tools.length) parts.push("생각 정리");
  return { text: parts.join(" · "), running: false };
}

function ToolRow({ item }: { item: Item<"tool"> }) {
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(item.output || (item.detail && item.tool !== "command"));
  return (
    <li className={`tool-row status-${item.status}`}>
      <button type="button" className="tool-row-head" onClick={() => hasBody && setOpen(!open)} aria-expanded={open}>
        <Icon name={TOOL_ICON[item.tool] ?? "tool"} size={14} className="tool-icon" />
        <span className={item.tool === "command" ? "tool-title mono" : "tool-title"}>{item.title}</span>
        <span className="tool-status">
          {item.status === "running" ? <span className="spinner" /> : item.status === "completed" ? <Icon name="check" size={14} /> : item.status === "declined" ? "거절됨" : "실패"}
        </span>
      </button>
      {open && hasBody ? (
        <pre className="tool-output">{[item.tool !== "command" ? item.detail : null, item.output].filter(Boolean).join("\n\n")}</pre>
      ) : null}
    </li>
  );
}

function WorkBlock({ block }: { block: Extract<Block, { type: "work" }> }) {
  const [open, setOpen] = useState(false);
  const summary = workSummary(block.items);
  return (
    <div className="work-block">
      <button type="button" className="work-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <span className={summary.running ? "work-summary-text running" : "work-summary-text"}>{summary.text}</span>
        {summary.running ? <span className="spinner" /> : null}
      </button>
      {open ? (
        <ul className="work-list">
          {block.items.map((item) =>
            item.kind === "tool" ? (
              <ToolRow key={item.id} item={item} />
            ) : (
              <li key={item.id} className="reasoning-row">
                {item.text}
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}

function ApprovalCard({ item, onAnswer, onTrust }: { item: Item<"approval">; onAnswer: (decision: "accept" | "decline") => void; onTrust?: () => void }) {
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
        <button type="button" className="button" onClick={() => onAnswer("decline")}>
          거절 <kbd>Esc</kbd>
        </button>
        <button type="button" className="button primary" onClick={() => onAnswer("accept")}>
          허용 <kbd>Enter</kbd>
        </button>
      </div>
    </div>
  );
}

function PlanCard({ item }: { item: Item<"plan"> }) {
  const done = item.steps.filter((step) => step.status === "completed").length;
  return (
    <div className="plan-card">
      <div className="plan-head">
        <span>계획</span>
        <span className="plan-progress">
          {done}/{item.steps.length}
        </span>
      </div>
      <ol className="plan-steps">
        {item.steps.map((step, index) => (
          <li key={index} className={`plan-step ${step.status}`}>
            <span className="plan-mark">{step.status === "completed" ? <Icon name="check" size={13} /> : step.status === "inProgress" ? <span className="spinner small" /> : null}</span>
            <span>{step.text}</span>
          </li>
        ))}
      </ol>
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

type RailMark = { id: string; index: number; top: number; text: string; attention: boolean };

const PIN_OPEN_KEY = "workbench.pinOpen";
/** Height of the folded request band; the band appears once the request slides under it. */
const PIN_HEIGHT = 46;

/** The first line of a request, without the Markdown marks that start it. */
function firstLine(text: string) {
  const line = text.split("\n").find((entry) => entry.trim()) ?? text;
  return line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").trim();
}

export function Transcript({
  sessionId,
  items,
  provider,
  running,
  loading,
  onAnswer,
  onTrust,
  focusItem,
  onFocusDone,
}: {
  sessionId: string;
  items: TranscriptItem[];
  provider: Provider;
  running: boolean;
  loading: boolean;
  onAnswer: (itemId: string, decision: "accept" | "decline") => void;
  /** "앞으로 묻지 않기": full access for this session (answers what waits, too). */
  onTrust?: () => void;
  /** Bring this message into view and mark it for a moment (a search hit). */
  focusItem?: { itemId: string; nonce: number } | null;
  onFocusDone?: () => void;
}) {
  const { state, actions: docActions } = useDocs();
  const scroller = useRef<HTMLDivElement>(null);
  // Follow the newest output only while the reader is at the bottom. Any move up (wheel, keys, the
  // scroll bar, touch) stops following at once; scrolling back down to the end resumes it.
  const pinned = useRef(true);
  const ownTop = useRef<number | null>(null);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const pinRef = useRef<HTMLDivElement>(null);
  const [pinOpen, setPinOpen] = useState(() => localStorage.getItem(PIN_OPEN_KEY) === "1");
  const sections = useRef(new Map<string, HTMLElement>());
  const blocks = toBlocks(items);
  const turns = toTurns(blocks);
  const pending = items.find((item): item is Item<"approval"> => item.kind === "approval" && item.decision === null);
  // The engine is working but nothing has arrived since the last request yet.
  const waitingFirst = running && blocks[blocks.length - 1]?.type === "user";
  const [sticky, setSticky] = useState<Turn | null>(null);
  const [rail, setRail] = useState<{ marks: RailMark[]; viewTop: number; viewHeight: number; current: string | null }>({ marks: [], viewTop: 0, viewHeight: 1, current: null });

  // Which request the reader is inside (sticky header) and where every request sits (turn rail).
  const measure = () => {
    const element = scroller.current;
    if (!element) return;
    const top = element.scrollTop;
    const height = Math.max(element.scrollHeight, 1);
    let current: Turn | null = null;
    const marks: RailMark[] = [];
    for (const turn of turns) {
      const section = sections.current.get(turn.id);
      if (!section || !turn.user) continue;
      marks.push({ id: turn.id, index: turn.index, top: section.offsetTop / height, text: turn.user.text, attention: turn.attention });
      if (section.offsetTop <= top + 12) current = turn;
    }
    const header = current ? sections.current.get(current.id)?.querySelector<HTMLElement>(".turn-request") : null;
    const section = current ? sections.current.get(current.id) : null;
    // Offsets are relative to the scroller (the positioned ancestor of both). The band takes over
    // once the request has slid under where the band sits, so it never pops up over the answer.
    const cover = pinRef.current?.offsetHeight ?? PIN_HEIGHT;
    const headerGone = header ? header.offsetTop + header.offsetHeight < top + cover : false;
    const stillInside = section ? section.offsetTop + section.offsetHeight > top + cover + 48 : false;
    const nextSticky = current && headerGone && stillInside ? current : null;
    setSticky((previous) => (previous?.id === nextSticky?.id ? previous : nextSticky));
    setAtBottom(element.scrollHeight - top - element.clientHeight < 24);
    const next = { marks, viewTop: top / height, viewHeight: element.clientHeight / height, current: current?.id ?? null };
    // Measuring runs after every render, so state only changes when something visible moved.
    const key = (value: typeof next) =>
      `${value.current}|${value.viewTop.toFixed(3)}|${value.viewHeight.toFixed(3)}|${value.marks.map((mark) => `${mark.id}:${mark.top.toFixed(3)}:${mark.attention}`).join(",")}`;
    setRail((previous) => (key(previous) === key(next) ? previous : next));
  };

  // Another session: start at its newest output again.
  useLayoutEffect(() => {
    pinned.current = true;
    lastTop.current = 0;
  }, [sessionId]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current && !focusItem && element.scrollTop + element.clientHeight < element.scrollHeight - 1) {
      element.scrollTop = element.scrollHeight;
      // Remember where this put us: the scroll event it raises is ours, not the reader's.
      ownTop.current = element.scrollTop;
    }
    measure();
  });

  // A search hit: scroll to that message once it is on screen, then mark it briefly.
  useEffect(() => {
    if (!focusItem || loading) return;
    const target = scroller.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(focusItem.itemId)}"]`);
    if (!target) return;
    pinned.current = false;
    target.scrollIntoView({ block: "center" });
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
    const timer = window.setTimeout(() => target.classList.remove("flash"), 2400);
    onFocusDone?.();
    return () => window.clearTimeout(timer);
  }, [focusItem, loading, items.length, onFocusDone]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  // Enter / Esc answer the pending approval when focus is not in a text field.
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("textarea, input, [contenteditable=true]")) return;
      if (event.key === "Enter") onAnswer(pending.id, "accept");
      else if (event.key === "Escape") onAnswer(pending.id, "decline");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onAnswer]);

  const jumpTo = (turnId: string) => {
    const section = sections.current.get(turnId);
    const element = scroller.current;
    if (!section || !element) return;
    pinned.current = false;
    element.scrollTo({ top: section.offsetTop - 8, behavior: "smooth" });
  };

  const toBottom = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  const speaker = (
    <div className="speaker engine">
      <EngineMark provider={provider} size={15} />
      {PROVIDER_LABEL[provider]}
    </div>
  );

  const renderBlock = (block: Block) => {
    switch (block.type) {
      case "user":
        return null;
      case "assistant":
        return (
          <div key={block.item.id} className="turn-assistant" data-item-id={block.item.id}>
            {block.speaker ? speaker : null}
            <AssistantText text={block.item.text} streaming={block.item.streaming} />
          </div>
        );
      case "work":
        return (
          <div key={block.id} className="turn-assistant">
            {block.speaker ? speaker : null}
            <WorkBlock block={block} />
          </div>
        );
      case "approval":
        return <ApprovalCard key={block.item.id} item={block.item} onAnswer={(decision) => onAnswer(block.item.id, decision)} onTrust={onTrust} />;
      case "plan":
        return <PlanCard key={block.item.id} item={block.item} />;
      case "notice":
        return (
          <div key={block.item.id} className={`notice notice-${block.item.level}`}>
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
      case "link":
        return <LinkEndCard key={block.item.id} linkId={block.item.linkId} />;
      case "turnEnd":
        return null;
    }
  };

  return (
    <div className="transcript-wrap">
      <div
        className="transcript"
        ref={scroller}
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
          const top = element.scrollTop;
          const own = ownTop.current !== null && Math.abs(top - ownTop.current) < 1;
          ownTop.current = null;
          if (!own) {
            if (element.scrollHeight - top - element.clientHeight < 4) pinned.current = true;
            else if (top < lastTop.current - 0.5) pinned.current = false;
          }
          lastTop.current = top;
          measure();
        }}
      >
        <div className="turn-pin-slot">
          {sticky?.user ? (
            <div className={`turn-pin${pinOpen ? " open" : ""}`} ref={pinRef}>
              <div className="column turn-pin-inner">
                <button type="button" className="turn-pin-main" onClick={() => jumpTo(sticky.id)} title="이 요청으로 올라가기">
                  <span className="turn-no">{sticky.index}</span>
                  {pinOpen ? null : <span className="turn-pin-text">{firstLine(sticky.user.text)}</span>}
                </button>
                {pinOpen ? (
                  <div className="turn-pin-full">
                    <RequestText text={sticky.user.text} />
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
              </div>
            </div>
          ) : null}
        </div>
        <div className="column transcript-inner">
          {loading ? <div className="empty-hint">불러오는 중…</div> : null}
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
              {turn.user ? (
                <header className="turn-request" data-item-id={turn.user.id}>
                  <div className="turn-meta">
                    <span className="turn-no">{turn.index}</span>
                    <span>{turn.user.link ? (turn.user.link.fromSessionId ? "받은 답" : "목표") : turn.user.peer ? "받은 메시지" : "요청"}</span>
                    <span className="turn-meta-sep">·</span>
                    <span>{clock(turn.user.at)}</span>
                    {turn.user.undelivered ? (
                      <span className="steer-tag undelivered" title="멈춰서 엔진에 전해지지 않았습니다. 입력창 위 목록에서 다시 보낼 수 있습니다.">
                        전해지지 않음
                      </span>
                    ) : turn.user.steered ? (
                      <span className="steer-tag" title="응답하는 중에 보내 하던 작업에 전한 요청">
                        작업 중 보냄
                      </span>
                    ) : null}
                  </div>
                  {turn.user.from ? (
                    <button type="button" className="from-badge" onClick={() => turn.user?.from && docActions.openSession(turn.user.from.sessionId)}>
                      <Icon name="arrowLeft" size={12} /> {turn.user.from.label}에서 온 요청
                    </button>
                  ) : null}
                  {turn.user.peer ? (
                    <span className="from-badge peer-badge" title={turn.user.peer.from ? `보낸 세션: ${turn.user.peer.from} (보낸 쪽이 밝힌 이름)` : undefined}>
                      <Icon name="arrowLeft" size={12} /> 다른 세션에서 온 메시지{turn.user.peer.name ? ` · ${turn.user.peer.name}` : ""}
                    </span>
                  ) : null}
                  {turn.user.link ? <LinkHopBadge hop={turn.user.link} /> : null}
                  {turn.user.link?.fromSessionId ? <LinkRequestText text={turn.user.text} /> : <RequestText text={turn.user.text} />}
                  {turn.user.refs?.length ? <RefChips refs={turn.user.refs} /> : null}
                  {turn.user.create ? (
                    <div className="ref-chips">
                      <span className="ref-chip create-chip" title={turn.user.create.path}>
                        → 새 {CREATE_LABEL[turn.user.create.format]}: {turn.user.create.name}
                      </span>
                    </div>
                  ) : null}
                </header>
              ) : null}
              <div className="turn-body">
                {turn.blocks.map(renderBlock)}
                {waitingFirst && position === turns.length - 1 ? (
                  <div className="turn-assistant">
                    {speaker}
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
                <div className={`turn-end turn-end-${turn.end.status}`}>
                  {turn.end.status === "completed" ? <Icon name="check" size={13} /> : null}
                  {turn.end.status === "completed" ? "끝남" : turn.end.status === "interrupted" ? "중단됨" : "응답이 끝나지 못했습니다"}
                  {duration(turn.end.durationMs) ? <span className="muted"> · {duration(turn.end.durationMs)}</span> : null}
                </div>
              ) : null}
              {turn.after.map(renderBlock)}
            </section>
          ))}
        </div>
      </div>
      {!atBottom ? (
        <button type="button" className="to-bottom" onClick={toBottom} title="맨 아래로">
          <Icon name="chevronDown" size={15} /> {running ? "새 응답 보기" : "맨 아래로"}
        </button>
      ) : null}
      {rail.marks.length >= 3 ? (
        <nav className="turn-rail" aria-label="요청 목록">
          <span className="turn-rail-view" style={{ top: `${rail.viewTop * 100}%`, height: `${Math.min(rail.viewHeight, 1) * 100}%` }} />
          {rail.marks.map((mark) => (
            <button
              key={mark.id}
              type="button"
              className={`turn-rail-mark${mark.id === rail.current ? " current" : ""}${mark.attention ? " attention" : ""}`}
              style={{ top: `${mark.top * 100}%` }}
              onClick={() => jumpTo(mark.id)}
              title={`${mark.index}. ${mark.text.slice(0, 80)}`}
              aria-label={`요청 ${mark.index}`}
            />
          ))}
        </nav>
      ) : null}
    </div>
  );
}
