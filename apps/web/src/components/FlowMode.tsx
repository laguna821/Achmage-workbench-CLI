import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEventsView, CalendarFeedView, Timeline } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { isWorking } from "../overview.ts";
import {
  FLOW_KEY,
  FLOW_VIEWS,
  LEGACY_FLOW_KEY,
  contains,
  dayKey,
  localDay,
  periodOf,
  readFlowState,
  shift,
  shiftYear,
  writeFlowState,
  type Day,
  type FlowView,
} from "../calendar.ts";
import { activityOf, periodTotals } from "../flow.ts";
import { Icon } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";
import { useOptionalPkm } from "./pkm/PkmContext.tsx";
import { CalendarFeedsSheet } from "./CalendarFeedsSheet.tsx";
import { DayGrid, FlowPicker, MonthGrid, WeekGrid, fullClock, type FlowOpen } from "./FlowViews.tsx";
import "../styles/flow.css";

// Home "흐름" as a calendar (2026-10-29, the user: "7일은 주단위 30일은 월간 단위여야 하는데"):
// 하루 (hours down the side, a column per work), 주 (weekdays × hours, Monday first) and 달 (the
// month grid), each tied to the real calendar and paged with ‹ 오늘 › (≪ ≫ by year in 달), ← → and
// T. Turns and revisions come from the gateway's timeline of that window; events of the calendars
// the user subscribed to ("캘린더 연결", iCal addresses) are drawn beside them, read-only.

export type { FlowOpen };

/** Windows already read (most recent last), so paging back and forth draws at once. */
const timelines = new Map<string, Timeline>();
const calendars = new Map<string, CalendarEventsView>();
/** The feeds as last seen: none means no events to ask for until the sheet changes them. */
let knownFeeds: CalendarFeedView[] | null = null;

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  if (map.size > 24) map.delete(map.keys().next().value!);
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true], [contenteditable=''], .cm-editor"));
/** Places where arrows already mean something (the tree, menus, sheets). */
const busyKeys = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest(".sidebar, [role=menu], [role=menuitem], [role=dialog], [role=listbox], [role=tree], [role=slider], [role=separator], .context-menu, .appearance-sheet"));

export function FlowMode({ api, state, open }: { api: Api; state: State; open: FlowOpen }) {
  const pkm = useOptionalPkm();
  const [now, setNow] = useState(() => Date.now());
  const today = localDay(now);
  const todayKey = dayKey(today);
  const [place, setPlace] = useState(() => readFlowState(localStorage.getItem(FLOW_KEY), localStorage.getItem(LEGACY_FLOW_KEY), localDay(Date.now())));
  const { view, anchor } = place;
  const anchorKey = dayKey(anchor);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const period = useMemo(() => periodOf(view, anchor, today), [view, anchorKey, todayKey]);
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [, redraw] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [feedsVersion, setFeedsVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const go = useCallback((next: { view?: FlowView; anchor?: Day }) => {
    setPicking(false);
    setPlace((current) => {
      const value = { view: next.view ?? current.view, anchor: next.anchor ?? current.anchor };
      localStorage.setItem(FLOW_KEY, writeFlowState(value.view, value.anchor, localDay(Date.now())));
      return value;
    });
  }, []);
  const step = useCallback((steps: number) => go({ anchor: shift(view, anchor, steps) }), [go, view, anchor]);
  const goToday = useCallback(() => go({ anchor: localDay(Date.now()) }), [go]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // ← → by the view's period, T for today; not while typing, nor where arrows move something else,
  // nor from a pane without the focus (two panes may both show home).
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || editable(event.target) || busyKeys(event.target)) return;
      if (root.current?.closest('[data-pane-active="false"]')) return;
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey) {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.code === "KeyT" || event.key === "t" || event.key === "T") {
        event.preventDefault();
        goToday();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, goToday]);

  // The timeline of this window; the window that holds now is read again as the app works (shortly
  // after a turn starts or ends, a reply arrives or a revision is made).
  const key = `${period.since}:${period.until}`;
  const live = period.since <= now && now < period.until;
  const changes = useMemo(() => {
    let working = 0;
    let last = 0;
    for (const session of Object.values(state.sessions)) {
      if (isWorking(session)) working += 1;
      last = Math.max(last, session.previewAt ?? 0);
    }
    for (const artifact of Object.values(state.artifacts)) last = Math.max(last, artifact.updatedAt);
    return `${working}:${last}`;
  }, [state.sessions, state.artifacts]);
  // Each answer is kept under its own window, so a late one never lands in another period.
  const load = useCallback(() => {
    void api
      .timeline(period.since, period.until)
      .then((result) => {
        remember(timelines, key, result);
        setError(null);
        redraw((value) => value + 1);
      })
      .catch((reason: Error) => setError(reason.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  useEffect(() => {
    const timer = window.setTimeout(load, timelines.has(key) ? 400 : 0);
    return () => window.clearTimeout(timer);
  }, [load, key]);
  // While the app works, read again at most every 400 ms: a throttle, not a debounce, so a reply
  // streaming in does not hold the running turn back until it has ended.
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (!live || pending.current !== null) return;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      load();
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes]);
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );

  // Calendar events of this window (the gateway fetches a feed again after 10 minutes).
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const tenMinutes = Math.floor(now / 600_000);
  useEffect(() => {
    if (knownFeeds && !knownFeeds.length && !feedsVersion) return;
    let active = true;
    void api
      .calendarEvents(period.since, period.until, zone)
      .then((result) => {
        if (!active) return;
        knownFeeds = result.feeds;
        remember(calendars, key, result);
        redraw((value) => value + 1);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, zone, feedsVersion, tenMinutes]);

  const timeline = timelines.get(key) ?? null;
  const calendar = calendars.get(key) ?? null;
  const events = calendar?.events ?? [];
  const feeds = calendar?.feeds ?? knownFeeds ?? [];
  // Only what activityOf reads: a reply streaming in elsewhere does not lay the calendar out again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activity = useMemo(() => activityOf(state, timeline, now), [state.sessions, state.works, state.artifacts, state.folders, timeline, now]);
  const totals = periodTotals(activity, period.since, period.until);
  const failing = feeds.filter((feed) => feed.error);
  const colors = useMemo(() => new Map(feeds.map((feed) => [feed.id, feed.color])), [feeds]);
  const names = useMemo(() => new Map(feeds.map((feed) => [feed.id, feed.name])), [feeds]);
  const unit = FLOW_VIEWS.find((entry) => entry.id === view)!.unit;
  const summary = !timeline
    ? (error ?? "불러오는 중…")
    : totals.requests || totals.revisions || events.length
      ? [`요청 ${totals.requests}`, `작업 ${totals.works}`, totals.revisions ? `판 ${totals.revisions}` : "", events.length ? `일정 ${events.length}` : ""].filter(Boolean).join(" · ")
      : "이 기간에 한 일이 없습니다";

  const refetchEvents = (refresh: boolean) => {
    setRefreshing(refresh);
    void api
      .calendarEvents(period.since, period.until, zone, refresh)
      .then((result) => {
        knownFeeds = result.feeds;
        remember(calendars, key, result);
        redraw((value) => value + 1);
      })
      .catch((reason: Error) => pkm?.onToast(reason.message))
      .finally(() => setRefreshing(false));
  };

  return (
    <div ref={root} className="flow-cal" data-view={view}>
      <div className="mode-head flow-head">
        <div className="flow-nav" role="group" aria-label="기간 이동">
          {view === "month" ? (
            <button type="button" className="icon-button small flow-step" aria-label="이전 해" title="이전 해" onClick={() => go({ anchor: shiftYear(anchor, -1) })}>
              <Icon name="chevronsLeft" size={16} />
            </button>
          ) : null}
          <button type="button" className="icon-button small flow-step" aria-label={`이전 ${unit}`} title={`이전 ${unit} (←)`} onClick={() => step(-1)}>
            <Icon name="chevronLeft" size={16} />
          </button>
          <button type="button" className="button small flow-today" title="오늘로 (T)" aria-current={contains(period, today) ? "date" : undefined} onClick={goToday}>
            오늘
          </button>
          <button type="button" className="icon-button small flow-step" aria-label={`다음 ${unit}`} title={`다음 ${unit} (→)`} onClick={() => step(1)}>
            <Icon name="chevronRight" size={16} />
          </button>
          {view === "month" ? (
            <button type="button" className="icon-button small flow-step" aria-label="다음 해" title="다음 해" onClick={() => go({ anchor: shiftYear(anchor, 1) })}>
              <Icon name="chevronsRight" size={16} />
            </button>
          ) : null}
        </div>
        <div className="flow-title-wrap">
          <button type="button" className="flow-title" aria-haspopup="dialog" aria-expanded={picking} title={view === "month" ? "해와 달 고르기" : "날짜 고르기"} onClick={() => setPicking(!picking)}>
            <span>{period.title}</span>
            <Icon name="chevronDown" size={14} />
          </button>
          <Popover open={picking} onClose={() => setPicking(false)} className="flow-picker-popover">
            <FlowPicker view={view} anchor={anchor} period={period} today={today} onPick={(day) => go({ anchor: day })} />
          </Popover>
        </div>
        <span className="flow-sum muted" aria-live="polite">
          {summary}
        </span>
        <div className="segmented small flow-views" role="radiogroup" aria-label="보기">
          {FLOW_VIEWS.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={view === entry.id} className={view === entry.id ? "active" : ""} onClick={() => go({ view: entry.id })}>
              {entry.label}
            </button>
          ))}
        </div>
        <button type="button" className={`icon-button small flow-feeds-button${feeds.length ? " on" : ""}`} aria-label="캘린더 연결" title={feeds.length ? `캘린더 연결 · ${feeds.map((feed) => feed.name).join(", ")}` : "캘린더 연결 (Google 캘린더 등)"} onClick={() => setSheet(true)}>
          <Icon name="calendar" size={16} />
        </button>
      </div>
      {failing.length ? (
        <div className="notice notice-error compact flow-feed-error" role="status">
          {failing.map((feed) => (
            <span key={feed.id}>
              '{feed.name}' 캘린더: {feed.error}
              {feed.fetchedAt ? ` ${fullClock(feed.fetchedAt)}에 받은 일정을 보여 줍니다.` : ""}
            </span>
          ))}
          <button type="button" className="text-button" disabled={refreshing} onClick={() => refetchEvents(true)}>
            {refreshing ? <span className="spinner small" /> : null} 다시 받기
          </button>
        </div>
      ) : null}
      {view === "day" ? (
        <DayGrid period={period} activity={activity} events={events} colors={colors} names={names} now={now} open={open} />
      ) : view === "week" ? (
        <WeekGrid period={period} activity={activity} events={events} colors={colors} names={names} now={now} open={open} onDay={(day) => go({ view: "day", anchor: day })} />
      ) : (
        <MonthGrid period={period} activity={activity} events={events} colors={colors} names={names} now={now} onDay={(day) => go({ view: "day", anchor: day })} />
      )}
      {sheet ? (
        <CalendarFeedsSheet
          api={api}
          onClose={() => setSheet(false)}
          onToast={(text) => pkm?.onToast(text)}
          onChanged={(next) => {
            knownFeeds = next;
            calendars.clear();
            setFeedsVersion((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}

