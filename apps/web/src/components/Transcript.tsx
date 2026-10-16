import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PROVIDER_LABEL, type Provider, type TranscriptItem } from "@workbench/contracts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon, type IconName } from "./Icon.tsx";

type Item<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>;

type Block =
  | { type: "user"; item: Item<"user"> }
  | { type: "assistant"; item: Item<"assistant">; speaker: boolean }
  | { type: "work"; id: string; items: (Item<"tool"> | Item<"reasoning">)[]; speaker: boolean }
  | { type: "approval"; item: Item<"approval"> }
  | { type: "plan"; item: Item<"plan"> }
  | { type: "notice"; item: Item<"notice"> }
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
      <Markdown remarkPlugins={[remarkGfm]}>{text || " "}</Markdown>
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

function ApprovalCard({ item, onAnswer }: { item: Item<"approval">; onAnswer: (decision: "accept" | "decline") => void }) {
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

type Turn = { id: string; index: number; user: Item<"user"> | null; blocks: Block[]; end: Item<"turnEnd"> | null; attention: boolean };

/** A turn is one request and everything the engine did for it. */
function toTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  let index = 0;
  for (const block of blocks) {
    if (block.type === "user" || !turns.length) {
      if (block.type === "user") index += 1;
      turns.push({ id: block.type === "user" ? block.item.id : "start", index, user: block.type === "user" ? block.item : null, blocks: [], end: null, attention: false });
      if (block.type === "user") continue;
    }
    const turn = turns[turns.length - 1];
    if (block.type === "turnEnd") turn.end = block.item;
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

export function Transcript({
  items,
  provider,
  running,
  loading,
  onAnswer,
}: {
  items: TranscriptItem[];
  provider: Provider;
  running: boolean;
  loading: boolean;
  onAnswer: (itemId: string, decision: "accept" | "decline") => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
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
    // Offsets are relative to the scroller (the positioned ancestor of both).
    const headerGone = header ? header.offsetTop + header.offsetHeight < top + 4 : false;
    const stillInside = section ? section.offsetTop + section.offsetHeight > top + 80 : false;
    const nextSticky = current && headerGone && stillInside ? current : null;
    setSticky((previous) => (previous?.id === nextSticky?.id ? previous : nextSticky));
    const next = { marks, viewTop: top / height, viewHeight: element.clientHeight / height, current: current?.id ?? null };
    // Measuring runs after every render, so state only changes when something visible moved.
    const key = (value: typeof next) =>
      `${value.current}|${value.viewTop.toFixed(3)}|${value.viewHeight.toFixed(3)}|${value.marks.map((mark) => `${mark.id}:${mark.top.toFixed(3)}:${mark.attention}`).join(",")}`;
    setRail((previous) => (key(previous) === key(next) ? previous : next));
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
    measure();
  });

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
    if (section && element) element.scrollTo({ top: section.offsetTop - 8, behavior: "smooth" });
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
          <div key={block.item.id} className="turn-assistant">
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
        return <ApprovalCard key={block.item.id} item={block.item} onAnswer={(decision) => onAnswer(block.item.id, decision)} />;
      case "plan":
        return <PlanCard key={block.item.id} item={block.item} />;
      case "notice":
        return (
          <div key={block.item.id} className={`notice notice-${block.item.level}`}>
            {block.item.text}
          </div>
        );
      case "turnEnd":
        return null;
    }
  };

  return (
    <div className="transcript-wrap">
      <div
        className="transcript"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          measure();
        }}
      >
        <div className="turn-sticky-slot">
          {sticky?.user ? (
            <button type="button" className="column turn-sticky" onClick={() => jumpTo(sticky.id)} title="이 요청으로 올라가기">
              <span className="turn-no">{sticky.index}</span>
              <span className="turn-sticky-text">{sticky.user.text}</span>
            </button>
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
                <header className="turn-request">
                  <div className="turn-meta">
                    <span className="turn-no">{turn.index}</span>
                    <span>요청</span>
                    <span className="turn-meta-sep">·</span>
                    <span>{clock(turn.user.at)}</span>
                  </div>
                  <div className="user-bubble">{turn.user.text}</div>
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
            </section>
          ))}
        </div>
      </div>
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
