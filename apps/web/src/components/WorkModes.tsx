import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { WORK_MODES, workModeKey, type WorkMode } from "../workmodes.ts";
import { ModeBar } from "./ModeBar.tsx";
import "../styles/views.css";

/**
 * The work screen's mode bar, above the input while a document of the work is open. With two panes
 * "나란히" rests: the panes already put things side by side (drag the document to the other side).
 */
export function WorkModeBar({ mode, onMode, canReview, canSplit = true }: { mode: WorkMode; onMode: (mode: WorkMode) => void; canReview: boolean; canSplit?: boolean }) {
  return (
    <div className="work-mode-row">
      <ModeBar
        className="work-mode-bar"
        label="작업 화면 보기"
        keyHint="Alt+"
        value={mode}
        onChange={onMode}
        modes={WORK_MODES.map((entry) => ({
          id: entry.id,
          label: entry.label,
          title: entry.id === "review" && !canReview ? "검토할 수정안이 없습니다" : entry.id === "split" && !canSplit ? "두 칸으로 볼 때는 쓰지 않습니다 · 문서를 다른 칸으로 끌어 놓으세요" : entry.title,
          disabled: (entry.id === "review" && !canReview && mode !== "review") || (entry.id === "split" && !canSplit && mode !== "split"),
        }))}
      />
    </div>
  );
}

/** Alt+1–5 switch the work screen's modes (also from inside the input). */
export function useWorkModeKeys(enabled: boolean, onMode: (mode: WorkMode) => void) {
  const latest = useRef(onMode);
  latest.current = onMode;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const mode = workModeKey(event);
      if (!mode) return;
      event.preventDefault();
      latest.current(mode);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

const clampRatio = (ratio: number) => Math.min(0.75, Math.max(0.25, ratio));

/**
 * "나란히": the conversation on the left, the document on the right, one input under both that
 * goes to the side last clicked. Without `split` only the document is shown, in the same place, so
 * switching between "문서" and "나란히" keeps the document (and its editor) as it is.
 */
export function SplitView({
  split,
  ratio,
  onRatio,
  focus,
  onFocus,
  tabs,
  left,
  right,
}: {
  split: boolean;
  ratio: number;
  onRatio: (ratio: number) => void;
  focus: "chat" | "doc";
  onFocus: (side: "chat" | "doc") => void;
  /** Open document tabs, above both sides. */
  tabs: ReactNode;
  /** The conversation, given where its input goes (null: the other side has it). */
  left: (slot: HTMLElement | null) => ReactNode;
  /** The document, given where its input goes (undefined: its own place, not split). */
  right: (slot: HTMLElement | null | undefined) => ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const shown = clampRatio(live ?? ratio);

  const drag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const box = host.current?.getBoundingClientRect();
    if (!box) return;
    let latest = shown;
    const onMove = (move: PointerEvent) => {
      latest = clampRatio((move.clientX - box.left) / box.width);
      setLive(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLive(null);
      onRatio(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const nudge = (event: ReactKeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -0.02 : event.key === "ArrowRight" ? 0.02 : 0;
    if (!step) return;
    event.preventDefault();
    onRatio(clampRatio(shown + step));
  };

  return (
    <div ref={host} className={`split-host${split ? " split" : ""}`}>
      {split ? tabs : null}
      <div className="split-panes" style={split ? { gridTemplateColumns: `minmax(0, ${shown}fr) 7px minmax(0, ${1 - shown}fr)` } : undefined}>
        {split ? (
          <section key="chat" className={`split-pane split-chat${focus === "chat" ? " focused" : ""}`} aria-label="대화" onPointerDownCapture={() => onFocus("chat")} onFocusCapture={() => onFocus("chat")}>
            {left(focus === "chat" ? slot : null)}
          </section>
        ) : null}
        {split ? (
          <div
            key="divider"
            className="split-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="대화와 문서 사이"
            aria-valuenow={Math.round(shown * 100)}
            tabIndex={0}
            onPointerDown={drag}
            onKeyDown={nudge}
            onDoubleClick={() => onRatio(0.5)}
            title="끌어서 너비 조절 · 두 번 누르면 반반"
          />
        ) : null}
        <section
          key="doc"
          className={`split-pane split-doc${split && focus === "doc" ? " focused" : ""}`}
          aria-label="문서"
          onPointerDownCapture={split ? () => onFocus("doc") : undefined}
          onFocusCapture={split ? () => onFocus("doc") : undefined}
        >
          {right(split ? (focus === "doc" ? slot : null) : undefined)}
        </section>
      </div>
      {split ? <div className="split-input" ref={setSlot} /> : null}
    </div>
  );
}
