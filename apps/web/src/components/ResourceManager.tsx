import { createContext, useId, useState } from "react";
import type { QueuedMessage, ResourceRunning, ResourceSettings, ResourceState, Session } from "@workbench/contracts";
import { SettingsRow, SettingsSwitch } from "./SettingsSheet.tsx";
import { Segmented } from "./ui/Hig.tsx";
import { Select } from "./ui/Select.tsx";

// The resource manager's surfaces (0.5.3): the settings rows under 설정 › AI 엔진, the window's bottom line
// "실행 4 · 대기 3" with its list, and what a waiting request says in its conversation. The gateway decides
// (`GET /api/resources`, event `resources.changed`); the window only shows and asks.

const MB = 1024 * 1024, GB = 1024 * MB;
const size = (bytes: number) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`);
const capLabel = (bytes: number | null) => (bytes ? `${Math.round(bytes / GB)} GB` : "끔");

/** 0.5.4: what a running turn says in 활동 and the bottom line's list: "12분째 · 380 MB". */
export function runningWords(turn: ResourceRunning, now: number, short = false): string {
  const parts: string[] = [];
  if (turn.since !== null) {
    const minutes = Math.floor(Math.max(0, now - turn.since) / 60_000);
    parts.push(minutes < 1 ? "방금 시작" : minutes < 60 ? `${minutes}분째` : `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}째`);
  }
  if (turn.bytes !== null) parts.push(size(turn.bytes));
  // The bottom line's list is narrow and its pressure line already says why: there, two words.
  if (turn.relieved) parts.push(short ? "다음 요청 대기" : "메모리가 부족해 다음 요청은 기다립니다");
  return parts.length ? parts.join(" · ") : "실행 중";
}

/** 0.5.4: the pressure line, naming each rung of the ladder reached. */
export function pressureWords(stage: ResourceState["stage"]): string {
  const done = stage >= 3 ? " 쉬는 엔진을 끄고 보이지 않는 탭을 쉬게 했습니다." : stage === 2 ? " 쉬는 엔진을 껐습니다." : "";
  const last = stage >= 4 ? " 급하지 않은 작업 하나가 메모리를 돌려주고, 그 대화의 다음 요청은 기다립니다." : "";
  return `메모리가 부족해 새 작업을 잠시 멈췄습니다.${done}${last}`;
}

const CAP_HINT: Record<ResourceState["capSupport"], string> = {
  enforced: "대화마다 엔진을 따로 묶어, 상한을 넘으면 그 대화의 엔진만 멈춥니다. 새로 시작하는 대화 엔진부터 적용됩니다. Codex 대화는 엔진 하나를 함께 써서 대화마다 걸 수 없습니다.",
  advised: "권장값입니다. 이 컴퓨터(Windows·macOS)에서는 앱이 대화마다 메모리 상한을 강제하지 못합니다.",
  unavailable: "이 컴퓨터에서는 상한을 걸 수 없습니다.",
  checking: "이 컴퓨터에서 상한을 걸 수 있는지 확인하고 있습니다.",
};

/** "이 컴퓨터에서는 약 N개까지 편하게 돌릴 수 있습니다 (어림)". */
export const comfortLine = (state: ResourceState) => `이 컴퓨터에서는 약 ${state.estimate.comfortable}개까지 편하게 돌릴 수 있습니다 (어림)`;

const READING_NOTE: Record<ResourceState["estimate"]["reading"], string | null> = {
  exact: null,
  close: "남은 메모리는 Windows가 알려 주는 값으로 셉니다.",
  rough: "이 컴퓨터는 남은 메모리를 실제보다 적게 알려 주어, 조심스럽게 셉니다.",
};

/** 설정 › AI 엔진 › 동시에 돌리는 작업: 자동 / 직접, the estimate in one line with 자세히, and the background priority switch. */
export function ResourceSettingsRows({ state, onChange }: { state: ResourceState; onChange: (patch: Partial<ResourceSettings>) => void }) {
  const { settings, estimate } = state;
  const numbers = Array.from({ length: state.maxLimit }, (_, index) => ({ value: index + 1, label: `${index + 1}개` }));
  const note = READING_NOTE[estimate.reading];
  return <>
    <SettingsRow className="resource-limit" label="동시에 돌리는 작업"
      hint={settings.mode === "auto" ? "이 컴퓨터의 메모리를 보고 한 번에 돌릴 AI 작업 수를 정합니다. 넘치는 작업은 차례를 기다렸다가 저절로 시작합니다." : "정한 수만큼만 한 번에 돌리고, 넘치는 작업은 차례를 기다립니다."}
      control={<div className="resource-limit-control">
        <Segmented label="동시에 돌리는 작업" value={settings.mode} onChange={(mode) => onChange({ mode })} options={[{ value: "auto", label: "자동" }, { value: "manual", label: "직접" }]} />
        {settings.mode === "manual" ? <Select<number> label="한 번에 돌릴 작업 수" value={settings.manual} options={numbers} onChange={(manual) => onChange({ manual })} /> : null}
      </div>}
      detail={<>
        <p className="settings-note resource-comfort">{comfortLine(state)}</p>
        <details className="settings-path resource-why">
          <summary>자세히</summary>
          <dl className="settings-facts resource-facts">
            <div><dt>전체 메모리</dt><dd>{size(estimate.totalBytes)}</dd></div>
            <div><dt>다른 데 쓰는 몫</dt><dd>{size(estimate.otherBytes)}</dd></div>
            <div><dt>작업 하나가 쓰는 평균</dt><dd>{size(estimate.costBytes)}{estimate.learned ? "" : " · 아직 측정 전이라 기본값"}</dd></div>
          </dl>
          {note ? <p className="settings-note">{note}</p> : null}
        </details>
      </>} />
    <SettingsRow className="resource-cap" label={state.capSupport === "advised" ? "대화당 메모리 상한 (권장값)" : "대화당 메모리 상한"} hint={CAP_HINT[state.capSupport]}
      control={state.capSupport === "enforced" || state.capSupport === "advised"
        ? <Select<number> label="대화당 메모리 상한" value={settings.cap ?? 0} options={state.capChoices.map((value) => ({ value: value ?? 0, label: capLabel(value) }))} onChange={(value) => onChange({ cap: value || null })} />
        : undefined} />
    <SettingsRow className="resource-background" label="뒤에서 도는 작업은 천천히" hint="화면에 없는 대화의 AI 엔진은 창보다 낮은 우선순위로 돌려, 보고 있는 화면이 느려지지 않게 합니다."
      control={<SettingsSwitch label="뒤에서 도는 작업은 천천히" checked={settings.background} onChange={(background) => onChange({ background })} />} />
  </>;
}

/** The line as the window knows it, for every list of waiting requests (conversation, document, web AI). */
export const ResourcesContext = createContext<ResourceState | null>(null);

/** A conversation's place in the line, or null when it does not wait for a slot. */
export function waitingOf(state: ResourceState | null, sessionId: string) {
  return state?.waiting.find((entry) => entry.sessionId === sessionId) ?? null;
}

/** What a waiting request says above the input: "대기 중 · 2번째 · 지금 동시에 4개까지 돌리고 있습니다". */
export function waitingWords(state: ResourceState | null, session: Session, entry: QueuedMessage): string | null {
  if (!entry.slot || entry.held) return null;
  const place = state?.waiting.find((item) => item.sessionId === session.id && item.requestId === entry.id);
  if (!place) return "대기 중";
  return `대기 중 · ${place.position}번째${state?.reason ? ` · ${state.reason}` : ""}`;
}

/**
 * "실행 4 · 대기 3" at the window's bottom line, beside the memory readout — only while something runs or
 * waits (or memory is short). A click opens the list: what runs, what waits and why, 지금 바로 실행 per row.
 */
export function ResourceLine({ state, onRunNow, onOpen, now = Date.now }: { state: ResourceState | null; onRunNow: (sessionId: string, requestId: string) => Promise<void>; onOpen?: (sessionId: string) => void; now?: () => number }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const id = useId();
  if (!state || (!state.running.length && !state.waiting.length && !state.pressure)) return null;
  const close = () => { setOpen(false); setSaid(null); };
  return (
    <div className="resource-line" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); close(); } }}>
      <button type="button" className="resource-line-text" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => (open ? close() : setOpen(true))}>
        실행 {state.running.length}{state.waiting.length ? ` · 대기 ${state.waiting.length}` : ""}{state.pressure ? " · 메모리 부족" : ""}
      </button>
      {open ? (
        <div id={id} role="group" aria-label="동시에 돌리는 작업" className="popover popover-above popover-right memory-pop resource-pop">
          <p className="memory-note">한 번에 {state.limit}개까지 · {state.settings.mode === "auto" ? "자동" : "직접 정함"}</p>
          {state.pressure ? <p className="memory-note resource-pressure" role="status">{pressureWords(state.stage || 1)}</p> : null}
          {state.running.length ? <dl className="memory-parts resource-rows" aria-label="실행 중">
            {state.running.map((turn) => <div key={turn.sessionId}><dt>{onOpen ? <button type="button" className="text-button" onClick={() => { onOpen(turn.sessionId); close(); }}>{turn.title}</button> : turn.title}</dt><dd>{turn.forced ? "바로 실행 · " : ""}{runningWords(turn, now(), true)}</dd></div>)}
          </dl> : null}
          {state.waiting.length ? <>
            {state.reason ? <p className="memory-note">{state.reason}</p> : null}
            <dl className="memory-parts resource-rows" aria-label="대기 중">
              {state.waiting.map((entry) => <div key={`${entry.sessionId}:${entry.requestId ?? "document"}`}>
                <dt>{entry.position}. {onOpen ? <button type="button" className="text-button" onClick={() => { onOpen(entry.sessionId); close(); }}>{entry.title}</button> : entry.title}{entry.kind === "document" ? " · 문서 AI" : ""}{entry.phone ? " · 휴대폰" : ""}</dt>
                <dd>{entry.requestId ? <button type="button" className="text-button resource-run-now" onClick={() => void onRunNow(entry.sessionId, entry.requestId!).then(() => setSaid("바로 시작했습니다."), (error: unknown) => setSaid(error instanceof Error ? error.message : "시작하지 못했습니다."))}>지금 바로 실행</button> : "대기 중"}</dd>
              </div>)}
            </dl>
          </> : null}
          {said ? <p className="memory-note" role="status">{said}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
