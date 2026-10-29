import { useCallback, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { PROVIDER_LABEL, type CalendarEvent, type Session, type Work } from "@workbench/contracts";
import { accentStyle, useAppearance } from "../appearance.ts";
import {
  WEEKDAYS,
  WEEK_ORDER,
  contains,
  dayKey,
  dayTitle,
  daysInMonth,
  hourRange,
  hoursIn,
  isWeekend,
  lanes,
  localDay,
  periodOf,
  sameDay,
  shortDay,
  weekdayOf,
  weeksOf,
  type Day,
  type FlowView,
  type Period,
} from "../calendar.ts";
import { cellKey, dayColumns, dayEvents, dayLines, monthDays, weekCells, type Activity, type DayBlock, type Revision, type Turn, type WeekCell } from "../flow.ts";
import type { MenuEntry } from "./ContextMenu.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import { useOptionalPkm } from "./pkm/PkmContext.tsx";

// The three calendar views of home "흐름" and the period picker. Work activity is drawn in the
// engine's colour (a turn as a block where its length is known, counts per hour or day); events of
// subscribed calendars in the feed's colour, read-only. A mark opens its session at that request
// (or a document at that revision); several at once open a menu to choose from.

export type FlowOpen = { session: (session: Session, itemId?: string) => void; work: (work: Work) => void; doc: (artifactId: string) => void };

type GridProps = { period: Period; activity: Activity; events: CalendarEvent[]; colors: Map<string, string>; names: Map<string, string>; now: number };

const DAY_HOUR = 44;
const WEEK_HOUR = 36;
/** A block is at least this tall, so its first line can be read. */
const MIN_BLOCK = 18;
const MONTH_LINES = 4;

const two = (value: number) => String(value).padStart(2, "0");
export const clock = (at: number) => {
  const date = new Date(at);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
};
export const fullClock = (at: number) => {
  const date = new Date(at);
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${clock(at)}`;
};
const length = (ms: number) => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}초`;
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}`;
};
const short = (text: string, size: number) => (Array.from(text).length > size ? `${Array.from(text).slice(0, size - 1).join("")}…` : text);
const statusWord = (turn: Turn) =>
  turn.running ? "진행 중" : turn.status === "failed" ? "실패" : turn.status === "interrupted" ? "멈춤" : turn.status === "open" ? "끝 기록 없음" : "끝남";
const turnLine = (turn: Turn) => `${clock(turn.start)} ${PROVIDER_LABEL[turn.session.provider]} · ${turn.text ?? turn.session.purpose} · ${length(turn.end - turn.start)} · ${statusWord(turn)}`;
const revisionLine = (revision: Revision) => `${clock(revision.at)} ${revision.artifact.name} r${revision.revision}${revision.author === "engine" ? " (엔진)" : revision.author === "external" ? " (밖에서)" : ""}`;
const eventLine = (event: CalendarEvent, names: Map<string, string>) =>
  `${event.days ? "종일" : `${clock(event.start)}–${clock(event.end)}`} ${event.title}${event.location ? ` · ${event.location}` : ""} · ${names.get(event.feedId) ?? "캘린더"}`;
const feedStyle = (colors: Map<string, string>, feedId: string) => ({ "--feed": colors.get(feedId) ?? "var(--muted)" }) as CSSProperties;

type Pick = { title: string; turns: Turn[]; revisions: Revision[] };

/** Open the one thing a mark stands for, or a menu of the requests and revisions it holds. */
function usePick(open: FlowOpen) {
  const pkm = useOptionalPkm();
  return useCallback(
    (pick: Pick, event: ReactMouseEvent<HTMLElement>) => {
      const total = pick.turns.length + pick.revisions.length;
      const first = pick.turns[0];
      if (!total) return;
      if (total === 1 || !pkm) {
        if (first) open.session(first.session, first.itemId);
        else open.doc(pick.revisions[0]!.artifact.id);
        return;
      }
      const box = event.currentTarget.getBoundingClientRect();
      const items: MenuEntry[] = [
        ...pick.turns.slice(0, 16).map(
          (turn): MenuEntry => ({
            kind: "item",
            label: `${clock(turn.start)} ${short(turn.work.title, 14)} · ${short(turn.text ?? turn.session.purpose, 30)}`,
            icon: "chat",
            hint: PROVIDER_LABEL[turn.session.provider],
            onSelect: () => open.session(turn.session, turn.itemId),
          }),
        ),
        ...(pick.turns.length && pick.revisions.length ? [{ kind: "separator" } as MenuEntry] : []),
        ...pick.revisions.slice(0, 10).map(
          (revision): MenuEntry => ({ kind: "item", label: `${clock(revision.at)} ${short(revision.artifact.name, 30)} r${revision.revision}`, icon: "file", onSelect: () => open.doc(revision.artifact.id) }),
        ),
      ];
      const hidden = Math.max(0, pick.turns.length - 16) + Math.max(0, pick.revisions.length - 10);
      if (hidden) items.push({ kind: "label", label: `외 ${hidden}개` });
      pkm.openMenu({ x: event.clientX || box.left, y: event.clientY || box.bottom, title: pick.title, items });
    },
    [open, pkm],
  );
}

/** Hour labels down the side; the one the time of now covers is left out. */
function HourScale({ from, to, hour, now }: { from: number; to: number; hour: number; now?: number | null }) {
  return (
    <div className="flow-hours" aria-hidden>
      {Array.from({ length: to - from }, (_, index) =>
        now !== undefined && now !== null && now - (from + index) >= 0 && now - (from + index) < 0.5 ? null : (
          <span key={from + index} className="flow-hour" style={{ top: index * hour }}>
            {from + index}시
          </span>
        ),
      )}
    </div>
  );
}

/** Empty hours folded at the top or bottom; a press shows the whole day. */
function Fold({ from, to, all, onAll }: { from: number; to: number; all: boolean; onAll: (all: boolean) => void }) {
  if (all) return null;
  if (from >= to) return null;
  return (
    <button type="button" className="flow-fold" onClick={() => onAll(true)} title="빈 시간도 보기">
      <span className="flow-gutter" />
      <span>
        {from}시–{to}시 · 기록 없음
      </span>
    </button>
  );
}

function NowLine({ top, label }: { top: number; label?: string }) {
  return (
    <div className="flow-now" style={{ top }} aria-hidden>
      {label ? <span className="flow-now-time">{label}</span> : null}
    </div>
  );
}

function AllDayChip({ event, colors, names }: { event: CalendarEvent; colors: Map<string, string>; names: Map<string, string> }) {
  return (
    <span className="flow-chip" style={feedStyle(colors, event.feedId)} title={eventLine(event, names)}>
      {event.title}
    </span>
  );
}

// ── 하루 ─────────────────────────────────────────────────────────────────

function blockTitle(block: DayBlock) {
  const lines = block.turns.slice(0, 8).map(turnLine);
  if (block.turns.length > 8) lines.push(`외 ${block.turns.length - 8}개`);
  return `${block.turns[0]!.work.title} · ${clock(block.start)}–${clock(block.end)} · 요청 ${block.turns.length}\n${lines.join("\n")}`;
}

/** "하루": hours down the side, a column per work (blocks of turns, revision marks), calendar events beside them. */
export function DayGrid({ period, activity, events, colors, names, now, open }: GridProps & { open: FlowOpen }) {
  const day = period.days[0]!;
  const { lookOf } = useAppearance();
  const pick = usePick(open);
  const [all, setAll] = useState(false);
  const minHours = MIN_BLOCK / DAY_HOUR;
  const columns = useMemo(() => dayColumns(day, activity, minHours), [day, activity, minHours]);
  const { allDay, timed } = useMemo(() => dayEvents(day, events), [day, events]);
  const nowHours = sameDay(day, localDay(now)) ? hoursIn(now, day) : null;
  const spans: [number, number][] = [
    ...columns.flatMap((column) => [...column.blocks.map((block): [number, number] => [block.top, Math.max(block.bottom, block.top + minHours)]), ...column.marks.map((mark): [number, number] => [mark.top, mark.top])]),
    ...timed.map((entry): [number, number] => [entry.top, Math.max(entry.bottom, entry.top + minHours)]),
  ];
  const [h0, h1] = hourRange(spans, nowHours, all);
  const y = (hours: number) => (hours - h0) * DAY_HOUR;
  const laid = lanes(timed.map((entry) => ({ ...entry, bottom: Math.max(entry.bottom, entry.top + minHours) })));
  const count = columns.length + (timed.length ? 1 : 0);
  return (
    <div className="flow-grid flow-day" style={{ "--hour": `${DAY_HOUR}px`, "--cols": Math.max(1, count) } as CSSProperties}>
      <div className="flow-row flow-day-head">
        <span className="flow-gutter" />
        {timed.length ? <span className="flow-day-colhead events">일정</span> : null}
        {columns.map((column) => (
          <button key={column.work.id} type="button" className="flow-day-colhead" onClick={() => open.work(column.work)} title={`${column.work.title} 열기`}>
            <span className="flow-day-colname">{column.work.title}</span>
            <span className="flow-day-colmeta">
              {column.providers.map((provider) => (
                <span key={provider} style={accentStyle(lookOf(provider))} className="flow-engine">
                  <EngineMark provider={provider} size={12} />
                </span>
              ))}
              요청 {column.requests}
              {column.revisions ? ` · 판 ${column.revisions}` : ""}
            </span>
          </button>
        ))}
        {!count ? <span className="flow-day-colhead empty">이 날에 한 일이 없습니다</span> : null}
      </div>
      {allDay.length ? (
        <div className="flow-row flow-allday-row">
          <span className="flow-gutter">종일</span>
          <div className="flow-allday-cell wide">
            {allDay.map((event) => (
              <AllDayChip key={event.id} event={event} colors={colors} names={names} />
            ))}
          </div>
        </div>
      ) : null}
      <Fold from={0} to={h0} all={all} onAll={setAll} />
      <div className="flow-body" style={{ height: (h1 - h0) * DAY_HOUR }}>
        <HourScale from={h0} to={h1} hour={DAY_HOUR} now={nowHours} />
        <div className="flow-cols">
          {timed.length ? (
            <div className="flow-col events">
              {laid.map((entry) => (
                <div
                  key={entry.event.id}
                  className="flow-event"
                  style={{ ...feedStyle(colors, entry.event.feedId), top: y(entry.top), height: Math.max((entry.bottom - entry.top) * DAY_HOUR, MIN_BLOCK), "--lane": entry.lane, "--lanes": entry.lanes } as CSSProperties}
                  title={eventLine(entry.event, names)}
                >
                  <span className="flow-event-time">{clock(entry.event.start)}</span>
                  <span className="flow-event-title">{entry.event.title}</span>
                </div>
              ))}
            </div>
          ) : null}
          {columns.map((column) => (
            <div key={column.work.id} className={`flow-col${column.marks.length ? " has-marks" : ""}`} data-work={column.work.id}>
              {column.blocks.map((block) => {
                const first = block.turns[0]!;
                const title = blockTitle(block);
                return (
                  <button
                    key={`${first.session.id}:${first.start}`}
                    type="button"
                    className={`flow-block${block.running ? " running" : ""}${block.failed ? " failed" : ""}`}
                    style={{ ...accentStyle(lookOf(block.provider)), top: y(block.top), height: Math.max((block.bottom - block.top) * DAY_HOUR, MIN_BLOCK) }}
                    title={title}
                    aria-label={title}
                    data-session={first.session.id}
                    data-item={first.itemId}
                    onClick={(event) => pick({ title: `${first.work.title} · ${clock(block.start)}–${clock(block.end)}`, turns: block.turns, revisions: [] }, event)}
                  >
                    <span className="flow-block-time">
                      {clock(block.start)}
                      {block.turns.length > 1 ? ` · 요청 ${block.turns.length}` : ""}
                    </span>
                    <span className="flow-block-text">{first.text ?? first.session.purpose}</span>
                  </button>
                );
              })}
              {column.marks.map((mark) => {
                const title = mark.revisions.map(revisionLine).join("\n");
                return (
                  <button
                    key={`${mark.revisions[0]!.artifact.id}:${mark.revisions[0]!.revision}`}
                    type="button"
                    className={`flow-mark author-${mark.revisions[0]!.author}`}
                    style={{ top: y(mark.top) }}
                    title={title}
                    aria-label={title}
                    onClick={(event) => pick({ title: `${column.work.title} · 판`, turns: [], revisions: mark.revisions }, event)}
                  >
                    <Icon name="file" size={12} />
                    {mark.revisions.length > 1 ? <span>{mark.revisions.length}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {!count ? <div className="flow-col" /> : null}
        </div>
        {nowHours !== null && nowHours >= h0 && nowHours <= h1 ? <NowLine top={y(nowHours)} label={clock(now)} /> : null}
      </div>
      <Fold from={h1} to={24} all={all} onAll={setAll} />
      {all ? (
        <button type="button" className="text-button flow-unfold" onClick={() => setAll(false)}>
          빈 시간 접기
        </button>
      ) : null}
    </div>
  );
}

// ── 주 ───────────────────────────────────────────────────────────────────

const heat = (cell: WeekCell) => {
  const total = cell.requests + cell.revisions;
  return total >= 8 ? 4 : total >= 4 ? 3 : total >= 2 ? 2 : total >= 1 ? 1 : 0;
};

function cellTitle(cell: WeekCell) {
  const head = `${shortDay(cell.day)} ${cell.hour}시 · 요청 ${cell.requests}${cell.revisions ? ` · 판 ${cell.revisions}` : ""}`;
  const works = cell.works.map((entry) => `${entry.work.title} ${PROVIDER_LABEL[entry.provider]}${entry.requests ? ` 요청 ${entry.requests}` : ""}${entry.revisions ? ` 판 ${entry.revisions}` : ""}`);
  const turns = cell.turns.slice(0, 6).map(turnLine);
  return [head, ...works, ...turns].join("\n");
}

/** "주": weekdays (Monday first) × hours; per hour, who worked, how much, and when turns ran. */
export function WeekGrid({ period, activity, events, colors, names, now, open, onDay }: GridProps & { open: FlowOpen; onDay: (day: Day) => void }) {
  const { lookOf } = useAppearance();
  const pick = usePick(open);
  const [all, setAll] = useState(false);
  const minHours = MIN_BLOCK / WEEK_HOUR;
  const cells = useMemo(() => weekCells(period.days, activity), [period, activity]);
  const perDay = useMemo(() => period.days.map((day) => dayEvents(day, events)), [period, events]);
  const today = localDay(now);
  const todayIndex = period.days.findIndex((day) => sameDay(day, today));
  const nowHours = todayIndex >= 0 ? hoursIn(now, period.days[todayIndex]!) : null;
  const spans: [number, number][] = [
    ...[...cells.values()].map((cell): [number, number] => [cell.hour, cell.hour + 1]),
    ...perDay.flatMap((entry) => entry.timed.map((timed): [number, number] => [timed.top, Math.max(timed.bottom, timed.top + minHours)])),
  ];
  const [h0, h1] = hourRange(spans, nowHours, all);
  const y = (hours: number) => (hours - h0) * WEEK_HOUR;
  const totals = period.days.map((day) => [...cells.values()].filter((cell) => sameDay(cell.day, day)).reduce((sum, cell) => sum + cell.requests, 0));
  const allDay = perDay.some((entry) => entry.allDay.length);
  return (
    <div className="flow-grid flow-week" style={{ "--hour": `${WEEK_HOUR}px`, "--cols": 7 } as CSSProperties}>
      <div className="flow-row flow-week-head">
        <span className="flow-gutter" />
        {period.days.map((day, index) => (
          <button
            key={dayKey(day)}
            type="button"
            className={`flow-week-day${isWeekend(day) ? " weekend" : ""}${index === todayIndex ? " today" : ""}`}
            onClick={() => onDay(day)}
            title={`${dayTitle(day)} — 하루 보기`}
            aria-label={`${dayTitle(day)}${totals[index] ? ` · 요청 ${totals[index]}` : ""} — 하루 보기`}
          >
            <span className="flow-wd">{WEEKDAYS[weekdayOf(day)]}</span>
            <span className="flow-date">{day.d === 1 ? `${day.m}/${day.d}` : day.d}</span>
            {totals[index] ? <span className="flow-week-count">요청 {totals[index]}</span> : null}
          </button>
        ))}
      </div>
      {allDay ? (
        <div className="flow-row flow-allday-row">
          <span className="flow-gutter">종일</span>
          {perDay.map((entry, index) => (
            <div key={dayKey(period.days[index]!)} className="flow-allday-cell">
              {entry.allDay.map((event) => (
                <AllDayChip key={event.id} event={event} colors={colors} names={names} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <Fold from={0} to={h0} all={all} onAll={setAll} />
      <div className="flow-body" style={{ height: (h1 - h0) * WEEK_HOUR }}>
        <HourScale from={h0} to={h1} hour={WEEK_HOUR} />
        <div className="flow-cols">
          {period.days.map((day, index) => {
            const timed = perDay[index]!.timed;
            const laid = lanes(timed.map((entry) => ({ ...entry, bottom: Math.max(entry.bottom, entry.top + minHours) })));
            const dayCells: WeekCell[] = [];
            for (let hour = h0; hour < h1; hour += 1) {
              const cell = cells.get(cellKey(day, hour));
              if (cell) dayCells.push(cell);
            }
            return (
              <div key={dayKey(day)} className={`flow-col${isWeekend(day) ? " weekend" : ""}${index === todayIndex ? " today" : ""}`} data-day={dayKey(day)}>
                {dayCells.map((cell) => {
                  const crowded = laid.some((entry) => entry.top < cell.hour + 1 && entry.bottom > cell.hour);
                  const title = cellTitle(cell);
                  return (
                    <button
                      key={cell.key}
                      type="button"
                      className={`flow-cell heat-${heat(cell)}${crowded ? " crowded" : ""}`}
                      style={{ top: y(cell.hour) + 1, height: WEEK_HOUR - 2 }}
                      title={title}
                      aria-label={title}
                      data-hour={cell.hour}
                      onClick={(event) => pick({ title: `${shortDay(cell.day)} ${cell.hour}시`, turns: cell.turns, revisions: cell.revisionList }, event)}
                    >
                      {cell.runs.map((run, at) => (
                        <span
                          key={at}
                          className={`flow-run${run.running ? " running" : ""}`}
                          style={{ ...accentStyle(lookOf(run.provider)), top: `${run.from * 100}%`, height: `${Math.max((run.to - run.from) * 100, 5)}%` }}
                        />
                      ))}
                      <span className="flow-cell-lines">
                        {cell.works.slice(0, 2).map((entry, line) => (
                          <span key={entry.work.id} className="flow-cell-line" style={accentStyle(lookOf(entry.provider))}>
                            <span className="flow-dot" />
                            <span className="flow-cell-name">{entry.work.title}</span>
                            {entry.requests + entry.revisions ? <span className="flow-cell-n">{entry.requests + entry.revisions}</span> : null}
                            {line === 1 && cell.works.length > 2 ? <span className="flow-cell-more">외 {cell.works.length - 2}</span> : null}
                          </span>
                        ))}
                      </span>
                    </button>
                  );
                })}
                {laid.map((entry) => {
                  const side = dayCells.some((cell) => entry.top < cell.hour + 1 && entry.bottom > cell.hour);
                  return (
                    <div
                      key={entry.event.id}
                      className={`flow-event${side ? " side" : ""}`}
                      style={{ ...feedStyle(colors, entry.event.feedId), top: y(entry.top), height: Math.max((entry.bottom - entry.top) * WEEK_HOUR, MIN_BLOCK), "--lane": entry.lane, "--lanes": entry.lanes } as CSSProperties}
                      title={eventLine(entry.event, names)}
                    >
                      <span className="flow-event-time">{clock(entry.event.start)}</span>
                      <span className="flow-event-title">{entry.event.title}</span>
                    </div>
                  );
                })}
                {index === todayIndex && nowHours !== null && nowHours >= h0 && nowHours <= h1 ? <NowLine top={y(nowHours)} /> : null}
              </div>
            );
          })}
        </div>
      </div>
      <Fold from={h1} to={24} all={all} onAll={setAll} />
      {all ? (
        <button type="button" className="text-button flow-unfold" onClick={() => setAll(false)}>
          빈 시간 접기
        </button>
      ) : null}
    </div>
  );
}

// ── 달 ───────────────────────────────────────────────────────────────────

/** "달": the month's whole weeks; each day lists its events and the works active on it. */
export function MonthGrid({ period, activity, events, colors, now, onDay }: GridProps & { onDay: (day: Day) => void }) {
  const { lookOf } = useAppearance();
  const days = useMemo(() => monthDays(period.days, activity, events), [period, activity, events]);
  const weeks = weeksOf(period);
  const today = localDay(now);
  return (
    <div className="flow-month" style={{ "--weeks": weeks.length } as CSSProperties}>
      <div className="flow-month-head" aria-hidden>
        {WEEK_ORDER.map((weekday) => (
          <span key={weekday} className={weekday === 0 || weekday === 6 ? "weekend" : ""}>
            {WEEKDAYS[weekday]}
          </span>
        ))}
      </div>
      <div className="flow-month-body">
        {weeks.flat().map((day) => {
          const entry = days.get(dayKey(day))!;
          const other = day.m !== period.month.m;
          const { lines, more } = dayLines(entry, MONTH_LINES);
          const parts = [
            dayTitle(day),
            entry.requests ? `요청 ${entry.requests}` : "",
            entry.revisions ? `판 ${entry.revisions}` : "",
            entry.works.length ? `작업 ${entry.works.map((work) => work.work.title).join(", ")}` : "",
            entry.events.length ? `일정 ${entry.events.map((event) => event.title).join(", ")}` : "",
          ].filter(Boolean);
          const label = `${parts.join(" · ")} — 하루 보기`;
          return (
            <button
              key={dayKey(day)}
              type="button"
              className={`flow-month-day${other ? " other" : ""}${isWeekend(day) ? " weekend" : ""}${sameDay(day, today) ? " today" : ""}`}
              data-day={dayKey(day)}
              onClick={() => onDay(day)}
              title={label}
              aria-label={label}
            >
              <span className="flow-month-date">{day.d === 1 ? `${day.m}월 1일` : day.d}</span>
              {lines.map((line) =>
                line.kind === "event" ? (
                  <span key={line.event.id} className={`flow-line event${line.event.days ? " allday" : ""}`} style={feedStyle(colors, line.event.feedId)}>
                    {line.event.days ? null : <span className="flow-line-time">{clock(line.event.start)}</span>}
                    <span className="flow-line-text">{line.event.title}</span>
                  </span>
                ) : (
                  <span key={line.work.work.id} className="flow-line work" style={accentStyle(lookOf(line.work.provider))}>
                    <span className="flow-dot" />
                    <span className="flow-line-text">{line.work.work.title}</span>
                    <span className="flow-line-n">{line.work.requests + line.work.revisions}</span>
                  </span>
                ),
              )}
              {more ? <span className="flow-line more">외 {more}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── 고르기 ───────────────────────────────────────────────────────────────

/** The title's picker: a year and its months (달), or a month of days (하루 · 주). */
export function FlowPicker({ view, anchor, period, today, onPick }: { view: FlowView; anchor: Day; period: Period; today: Day; onPick: (day: Day) => void }) {
  const [shown, setShown] = useState({ y: anchor.y, m: anchor.m });
  const move = (months: number) => {
    const index = shown.y * 12 + shown.m - 1 + months;
    setShown({ y: Math.floor(index / 12), m: (index % 12) + 1 });
  };
  if (view === "month") {
    return (
      <div className="flow-picker" aria-label="해와 달 고르기">
        <div className="flow-picker-head">
          <button type="button" className="icon-button small" aria-label="이전 해" onClick={() => move(-12)}>
            <Icon name="chevronLeft" size={14} />
          </button>
          <span>{shown.y}년</span>
          <button type="button" className="icon-button small" aria-label="다음 해" onClick={() => move(12)}>
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
        <div className="flow-picker-months">
          {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
            <button
              key={month}
              type="button"
              className={`${shown.y === anchor.y && month === anchor.m ? "active" : ""}${shown.y === today.y && month === today.m ? " today" : ""}`}
              aria-current={shown.y === anchor.y && month === anchor.m ? "date" : undefined}
              onClick={() => onPick({ y: shown.y, m: month, d: Math.min(anchor.d, daysInMonth(shown.y, month)) })}
            >
              {month}월
            </button>
          ))}
        </div>
      </div>
    );
  }
  const grid = periodOf("month", { y: shown.y, m: shown.m, d: 1 }, today);
  return (
    <div className="flow-picker" aria-label="날짜 고르기">
      <div className="flow-picker-head">
        <button type="button" className="icon-button small" aria-label="이전 달" onClick={() => move(-1)}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <span>
          {shown.y}년 {shown.m}월
        </span>
        <button type="button" className="icon-button small" aria-label="다음 달" onClick={() => move(1)}>
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      <div className="flow-picker-days">
        {WEEK_ORDER.map((weekday) => (
          <span key={weekday} className="flow-picker-wd">
            {WEEKDAYS[weekday]}
          </span>
        ))}
        {grid.days.map((day) => (
          <button
            key={dayKey(day)}
            type="button"
            className={`${day.m !== shown.m ? "other" : ""}${contains(period, day) ? " active" : ""}${sameDay(day, today) ? " today" : ""}`}
            aria-label={dayTitle(day)}
            onClick={() => onPick(day)}
          >
            {day.d}
          </button>
        ))}
      </div>
    </div>
  );
}
