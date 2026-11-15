import { useEffect, useRef, useState } from "react";
import type { Schedule, SchedulePolicy, ScheduleWhen, Session } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";
import { ScheduleHistory } from "./ScheduleHistory.tsx";
import "../styles/schedules.css";

type Kind = ScheduleWhen["kind"];

/** How a schedule reads: "매일 09:00", "10월 29일 오후 3:00 한 번", "3시간마다". */
export function whenText(when: ScheduleWhen) {
  if (when.kind === "daily") return `매일 ${when.time}`;
  if (when.kind === "every") return `${when.hours}시간마다`;
  return `${new Date(when.at).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} 한 번`;
}

const nextText = (at: number | null) =>
  at === null ? "끝남" : `다음: ${new Date(at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" })}`;

/** A local "YYYY-MM-DDTHH:MM" an hour from now, for the date-time field. */
function inAnHour() {
  const at = new Date(Date.now() + 3_600_000);
  at.setSeconds(0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * "예약 작업" of a session: requests it gets at set times (every day, once, every few hours). The
 * gateway sends them while the app runs; one due while the engine works goes when it finishes.
 */
export function ScheduleDialog({ api, session, schedules, onClose, onError, onOpenSession }: { api: Api; session: Session; schedules: Schedule[]; onClose: () => void; onError: (error: unknown) => void; onOpenSession?: (id: string) => void }) {
  const mine = schedules.filter((entry) => entry.sessionId === session.id).sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  const [text, setText] = useState("");
  const [kind, setKind] = useState<Kind>("daily");
  const [time, setTime] = useState("09:00");
  const [at, setAt] = useState(inAnHour);
  const [hours, setHours] = useState(3);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<SchedulePolicy["mode"]>("resume_session");
  const [missed, setMissed] = useState<SchedulePolicy["missed"]>("once");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [expires, setExpires] = useState("");
  const [limit, setLimit] = useState("");
  const [history, setHistory] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  // Esc closes it wherever the focus is (a removed row's button takes the focus with it).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const add = async () => {
    if (!text.trim() || saving) return;
    const when: ScheduleWhen = kind === "daily" ? { kind, time } : kind === "every" ? { kind, hours } : { kind, at: new Date(at).getTime() };
    setSaving(true);
    try {
      await api.createSchedule({ sessionId: session.id, text: text.trim(), when,
        policy: { mode, missed, timezone, expiresAt: expires ? new Date(expires).getTime() : null, maxRuns: limit ? Number(limit) : null } });
      setText("");
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="schedule-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`예약 작업 · ${session.purpose}`}
      >
        <header className="schedule-head">
          <h2>
            <Icon name="clock" size={18} /> 예약 작업
          </h2>
          <p className="muted">
            「{session.purpose}」을 기준으로 정한 때 요청을 보냅니다. 백그라운드 호스트가 실행 중이면 창을 닫아도 이어집니다. 엔진이 일하는 중이거나 승인을 기다리면 대기열에 보냅니다.
          </p>
        </header>

        <div className="schedule-list" role="list">
          {mine.length ? null : <div className="schedule-empty">아직 예약이 없습니다.</div>}
          {mine.map((entry) => (
            <div key={entry.id} role="listitem"><div className={`schedule-row${entry.enabled ? "" : " off"}`}>
              <div className="schedule-main">
                <span className="schedule-when">{whenText(entry.when)}</span>
                <span className="schedule-text" title={entry.text}>
                  {entry.text.split("\n")[0]}
                </span>
                <span className="schedule-next">{entry.enabled ? nextText(entry.nextAt) : entry.offReason === "locked" ? "휴대폰 채팅을 잠가 꺼짐 · 잠금을 풀어야 켤 수 있습니다" : entry.offReason === "disconnected" ? "휴대폰 연결을 끊어 꺼짐" : "꺼짐"}</span>
                {entry.origin ? <span className="schedule-next">휴대폰 채팅에서 만든 예약 · 결과는 그 채팅으로 갑니다</span> : null}
                <span className="schedule-next">{entry.policy?.mode === "new_run" ? "매번 새 대화" : "현재 대화 이어서"} · {entry.policy?.timezone ?? "기기 시간대"} · {entry.runCount ?? 0}회 접수{entry.policy?.maxRuns ? ` / 최대 ${entry.policy.maxRuns}회` : ""}</span>
              </div>
              <button type="button" className="text-button" onClick={() => setHistory(history === entry.id ? null : entry.id)} aria-expanded={history === entry.id}>실행 기록</button>
              {entry.nextAt !== null || entry.when.kind !== "once" ? (
                <button type="button" className="text-button" onClick={() => void api.updateSchedule(entry.id, { enabled: !entry.enabled }).catch(onError)}>
                  {entry.enabled ? "끄기" : "켜기"}
                </button>
              ) : null}
              <button type="button" className="icon-button small" aria-label="예약 지우기" title="지우기" onClick={() => void api.removeSchedule(entry.id).catch(onError)}>
                <Icon name="x" size={14} />
              </button>
            </div>{history === entry.id ? <ScheduleHistory api={api} schedule={entry} onError={onError} onOpenSession={onOpenSession} /> : null}</div>
          ))}
        </div>

        <div className="schedule-form">
          <textarea ref={field} rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder="보낼 요청 (예: 어제 바뀐 문서를 요약해 줘)" />
          <div className="schedule-policy">
            <label>실행 방식<select value={mode} onChange={event => setMode(event.target.value as SchedulePolicy["mode"])}><option value="resume_session">현재 대화 이어서</option><option value="new_run">같은 작업공간에서 매번 새 대화</option></select></label>
            <label>호스트가 꺼져 있던 동안<select value={missed} onChange={event => setMissed(event.target.value as SchedulePolicy["missed"])}><option value="once">지난 예약을 한 번만 보내기</option><option value="skip">1분 넘게 지난 예약 건너뛰기</option></select></label>
            {kind === "daily" ? <label>매일 예약 시간대<input value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Asia/Seoul" /></label> : null}
            <label>종료 기한 (선택)<input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} /></label>
            <label>최대 실행 횟수 (선택)<input type="number" min={1} max={100000} value={limit} onChange={event => setLimit(event.target.value)} placeholder="제한 없음" /></label>
          </div>
          <div className="schedule-when-row">
            <div className="segmented" role="radiogroup" aria-label="반복">
              {(
                [
                  ["daily", "매일"],
                  ["once", "한 번"],
                  ["every", "N시간마다"],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>
                  {label}
                </button>
              ))}
            </div>
            {kind === "daily" ? <input type="time" value={time} onChange={(event) => setTime(event.target.value)} aria-label="시각" /> : null}
            {kind === "once" ? <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} aria-label="날짜와 시각" /> : null}
            {kind === "every" ? (
              <label className="schedule-hours">
                <input type="number" min={1} max={168} value={hours} onChange={(event) => setHours(Math.max(1, Math.min(168, Number(event.target.value) || 1)))} aria-label="시간 간격" />
                시간마다
              </label>
            ) : null}
            <button type="button" className="button primary" onClick={() => void add()} disabled={!text.trim() || saving}>
              예약 추가
            </button>
          </div>
        </div>
        <footer className="schedule-foot">
          <button type="button" className="button" onClick={onClose}>
            닫기
          </button>
        </footer>
      </div>
    </div>
  );
}
