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
  const blocks = toBlocks(items);
  const pending = items.find((item): item is Item<"approval"> => item.kind === "approval" && item.decision === null);
  // The engine is working but nothing has arrived since the last request yet.
  const waitingFirst = running && blocks[blocks.length - 1]?.type === "user";

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
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

  return (
    <div
      className="transcript"
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      <div className="column transcript-inner">
        {loading ? <div className="empty-hint">불러오는 중…</div> : null}
        {!loading && !blocks.length ? <div className="empty-hint">이 세션에 요청을 보내면 여기에 대화가 이어집니다.</div> : null}
        {blocks.map((block) => {
          switch (block.type) {
            case "user":
              return (
                <section key={block.item.id} className="turn-user">
                  <div className="user-bubble">{block.item.text}</div>
                </section>
              );
            case "assistant":
              return (
                <section key={block.item.id} className="turn-assistant">
                  {block.speaker ? <div className="speaker engine">
              <EngineMark provider={provider} size={15} />
              {PROVIDER_LABEL[provider]}
            </div> : null}
                  <AssistantText text={block.item.text} streaming={block.item.streaming} />
                </section>
              );
            case "work":
              return (
                <section key={block.id} className="turn-assistant">
                  {block.speaker ? <div className="speaker engine">
              <EngineMark provider={provider} size={15} />
              {PROVIDER_LABEL[provider]}
            </div> : null}
                  <WorkBlock block={block} />
                </section>
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
              return block.item.status === "completed" ? null : (
                <div key={block.item.id} className="turn-end">
                  {block.item.status === "interrupted" ? "중단됨" : "응답이 끝나지 못했습니다"}
                </div>
              );
          }
        })}
        {waitingFirst ? (
          <section className="turn-assistant">
            <div className="speaker engine">
              <EngineMark provider={provider} size={15} />
              {PROVIDER_LABEL[provider]}
            </div>
            <div className="response-pending" role="status" aria-label="응답을 기다리는 중">
              <span className="response-pending-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
