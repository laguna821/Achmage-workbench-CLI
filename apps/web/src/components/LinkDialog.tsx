import { useEffect, useMemo, useRef, useState } from "react";
import { LINK_LIMITS, LINK_PRESETS, PROVIDER_LABEL, type Session } from "@workbench/contracts";
import { accentStyle, useAppearance } from "../appearance.ts";
import { statusText } from "../format.ts";
import { linkOfSession, type LinkStart } from "../links.ts";
import { isBusy, type State } from "../state.ts";
import { sessionHidden } from "../tree.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import "../styles/links.css";

const clamp = (value: number, limits: { min: number; max: number }) => Math.min(limits.max, Math.max(limits.min, value));

/** Minutes step by 5 (by 1 under 5), kept within the limits. */
function stepMinutes(minutes: number, direction: 1 | -1) {
  if (direction === -1) return clamp(minutes <= 5 ? minutes - 1 : minutes - (minutes % 5 || 5), LINK_LIMITS.minutes);
  return clamp(minutes < 5 ? minutes + 1 : minutes + 5 - (minutes % 5), LINK_LIMITS.minutes);
}

function Stepper({ label, value, unit, onChange, limits, step }: { label: string; value: number; unit: string; onChange: (value: number) => void; limits: { min: number; max: number }; step: (value: number, direction: 1 | -1) => number }) {
  return (
    <div className="linked-stepper" role="group" aria-label={label}>
      <span className="linked-stepper-label">{label}</span>
      <button type="button" className="icon-button small" onClick={() => onChange(step(value, -1))} disabled={value <= limits.min} aria-label={`${label} 줄이기`}>
        −
      </button>
      <span className="linked-stepper-value" aria-live="polite">
        {value}
        {unit}
      </span>
      <button type="button" className="icon-button small" onClick={() => onChange(step(value, 1))} disabled={value >= limits.max} aria-label={`${label} 늘리기`}>
        +
      </button>
    </div>
  );
}

/**
 * "세션 잇기": which sessions talk (in speaking order, two to six), about what, and for how long —
 * a preset (가볍게 · 보통 · 깊게) or rounds and minutes set one by one.
 */
export function LinkDialog({
  state,
  initial,
  initialGoal,
  onStart,
  onClose,
}: {
  state: State;
  /** Sessions chosen to begin with (e.g. the dragged pair), in order. */
  initial: string[];
  initialGoal?: string;
  onStart: (start: LinkStart) => Promise<boolean>;
  onClose: () => void;
}) {
  const { lookOf } = useAppearance();
  // A session already in a live link cannot join another one.
  const [chosen, setChosen] = useState<string[]>(() => initial.filter((id) => state.sessions[id] && !linkOfSession(state, id)).slice(0, LINK_LIMITS.participants.max));
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [rounds, setRounds] = useState<number>(LINK_PRESETS[1].rounds);
  const [minutes, setMinutes] = useState<number>(LINK_PRESETS[1].minutes);
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);
  const goalRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    goalRef.current?.focus();
  }, []);

  const firstWork = chosen[0] ? state.sessions[chosen[0]]?.workId : undefined;
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const recency = (session: Session) => Math.max(session.previewAt ?? 0, session.updatedAt);
    return Object.values(state.sessions)
      .filter((session) => chosen.includes(session.id) || !sessionHidden(state, session))
      .filter((session) => {
        if (!needle) return true;
        const work = state.works[session.workId];
        return [session.purpose, work?.title, PROVIDER_LABEL[session.provider]].some((text) => text?.toLowerCase().includes(needle));
      })
      .sort(
        (a, b) =>
          Number(chosen.includes(b.id)) - Number(chosen.includes(a.id)) ||
          (chosen.includes(a.id) ? chosen.indexOf(a.id) - chosen.indexOf(b.id) : 0) ||
          Number(b.workId === firstWork) - Number(a.workId === firstWork) ||
          recency(b) - recency(a),
      )
      .slice(0, 40);
  }, [state, chosen, query, firstWork]);

  const toggle = (session: Session) =>
    setChosen((current) => (current.includes(session.id) ? current.filter((id) => id !== session.id) : current.length >= LINK_LIMITS.participants.max ? current : [...current, session.id]));

  const busy = chosen.map((id) => state.sessions[id]).filter((session): session is Session => Boolean(session && isBusy(session)));
  const enough = chosen.length >= LINK_LIMITS.participants.min;
  const canStart = enough && goal.trim().length > 0 && !busy.length && !sending;
  const preset = LINK_PRESETS.find((entry) => entry.rounds === rounds && entry.minutes === minutes)?.id ?? null;
  const usage = Math.max(
    0,
    ...[...new Set(chosen.map((id) => state.sessions[id]?.provider))].flatMap((provider) =>
      provider ? (state.providers[provider]?.usage ?? []).filter((window) => window.label === "5시간").map((window) => window.usedPercent ?? 0) : [],
    ),
  );

  const start = async () => {
    if (!canStart) return;
    setSending(true);
    try {
      if (await onStart({ participants: chosen, goal: goal.trim(), maxRounds: rounds, maxMinutes: minutes })) onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="linked-dialog"
        role="dialog"
        aria-label="세션 잇기"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void start();
          }
        }}
      >
        <header className="linked-dialog-head">
          <h2>
            <span aria-hidden>⇄</span> 세션 잇기
          </h2>
          <p className="muted">고른 세션들이 정한 횟수와 시간 안에서 번갈아 답을 주고받습니다. 상대의 답은 지시나 승인이 아니라 참고로 전합니다. 어느 세션에든 직접 쓰면 멈춥니다.</p>
        </header>

        <div className="linked-dialog-body">
          <section className="linked-dialog-section">
            <div className="linked-dialog-label">
              <span>참여 세션 · {chosen.length}개</span>
              <span className="muted">먼저 답하는 순서대로 고르세요 (2~6개)</span>
            </div>
            {chosen.length ? (
              <div className="linked-order">
                {chosen.map((id, index) => {
                  const session = state.sessions[id];
                  return session ? (
                    <span key={id} className="linked-order-chip" style={accentStyle(lookOf(session.provider))}>
                      <span className="linked-order-no">{index + 1}</span>
                      <EngineMark provider={session.provider} size={13} />
                      {session.purpose}
                    </span>
                  ) : null;
                })}
                {chosen.length > 1 ? (
                  <button type="button" className="link" onClick={() => setChosen((current) => [...current.slice(1), current[0]!])} title="먼저 답할 세션을 바꿉니다">
                    순서 바꾸기
                  </button>
                ) : null}
              </div>
            ) : null}
            <label className="search-field linked-search">
              <Icon name="search" size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="세션 이름·작업·엔진으로 찾기" />
            </label>
            <div className="linked-candidates" role="listbox" aria-multiselectable aria-label="참여 세션">
              {candidates.map((session) => {
                const at = chosen.indexOf(session.id);
                const other = linkOfSession(state, session.id);
                const taken = Boolean(other) && at === -1;
                const work = state.works[session.workId];
                return (
                  <button
                    key={session.id}
                    type="button"
                    role="option"
                    aria-selected={at !== -1}
                    className={`linked-candidate${at !== -1 ? " chosen" : ""}`}
                    style={accentStyle(lookOf(session.provider))}
                    disabled={taken || (at === -1 && chosen.length >= LINK_LIMITS.participants.max)}
                    onClick={() => toggle(session)}
                  >
                    <span className="linked-candidate-check">{at !== -1 ? at + 1 : ""}</span>
                    <EngineMark provider={session.provider} size={15} />
                    <span className="linked-candidate-name">{session.purpose}</span>
                    <span className="linked-candidate-meta">
                      {PROVIDER_LABEL[session.provider]}
                      {work ? ` · ${work.title}` : ""}
                      {taken ? " · 다른 잇기 중" : isBusy(session) ? ` · ${statusText(session)}` : ""}
                    </span>
                  </button>
                );
              })}
              {!candidates.length ? <div className="picker-empty">맞는 세션이 없습니다.</div> : null}
            </div>
          </section>

          <section className="linked-dialog-section">
            <label className="linked-dialog-label" htmlFor="linked-goal">
              <span>목표</span>
              <span className="muted">무엇에 이르면 끝낼지 적어 주세요</span>
            </label>
            <textarea
              id="linked-goal"
              ref={goalRef}
              className="linked-goal"
              rows={3}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="예: 이 강의 계획의 약점을 서로 검토하고 고칠 점 세 가지에 합의"
            />
          </section>

          <section className="linked-dialog-section">
            <div className="linked-dialog-label">
              <span>얼마나</span>
            </div>
            <div className="linked-presets" role="radiogroup" aria-label="주고받는 양">
              {LINK_PRESETS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={preset === entry.id}
                  className={`linked-preset${preset === entry.id ? " active" : ""}`}
                  onClick={() => {
                    setRounds(entry.rounds);
                    setMinutes(entry.minutes);
                  }}
                >
                  <span className="linked-preset-name">{entry.label}</span>
                  <span className="linked-preset-meta">
                    {entry.rounds}왕복 · {entry.minutes}분
                  </span>
                </button>
              ))}
            </div>
            <div className="linked-steppers">
              <Stepper label="왕복" value={rounds} unit="왕복" limits={LINK_LIMITS.rounds} step={(value, direction) => clamp(value + direction, LINK_LIMITS.rounds)} onChange={setRounds} />
              <Stepper label="시간" value={minutes} unit="분" limits={LINK_LIMITS.minutes} step={stepMinutes} onChange={setMinutes} />
            </div>
            <p className="linked-summary">
              {enough
                ? `모두 ${chosen.length * rounds}번 주고받고, 길어도 ${minutes}분이면 끝납니다. [[합의]]가 나오거나 같은 말이 되풀이되면 일찍 끝납니다.`
                : "세션을 둘 이상 고르면 시작할 수 있습니다."}
              {usage >= 75 ? ` 5시간 사용량이 ${Math.round(usage)}%입니다. 90%를 넘으면 멈춥니다.` : ""}
            </p>
            {busy.length ? <p className="linked-warning">응답 중인 세션이 끝나야 시작할 수 있습니다: {busy.map((session) => session.purpose).join(", ")}</p> : null}
          </section>
        </div>

        <footer className="linked-dialog-foot">
          <button type="button" className="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="button primary" onClick={() => void start()} disabled={!canStart} title="Ctrl+Enter">
            잇기 시작
          </button>
        </footer>
      </div>
    </div>
  );
}
