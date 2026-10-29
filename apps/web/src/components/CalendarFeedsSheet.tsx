import { useEffect, useState, type CSSProperties } from "react";
import { CALENDAR_COLORS, type CalendarFeedView } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { ago } from "../format.ts";
import { Icon } from "./Icon.tsx";
import "../styles/flow.css";

// "캘린더 연결" (home "흐름"): calendars subscribed by their iCal address, shown read-only in the
// day, week and month views. No sign-in: Google Calendar's "iCal 형식의 비밀 주소" is enough. The
// address goes to the gateway once and stays on this computer; this screen never gets it back.

const COLOR_NAMES = ["파랑", "청록", "호박", "빨강", "보라", "초록", "회색"];

function Swatches({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  return (
    <div className="calendar-swatches" role="radiogroup" aria-label={label}>
      {CALENDAR_COLORS.map((color, index) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value.toUpperCase() === color}
          aria-label={COLOR_NAMES[index]}
          title={COLOR_NAMES[index]}
          className={`calendar-swatch${value.toUpperCase() === color ? " on" : ""}`}
          style={{ "--feed": color } as CSSProperties}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}

function FeedRow({ api, feed, onChanged, onError }: { api: Api; feed: CalendarFeedView; onChanged: (feeds: CalendarFeedView[] | CalendarFeedView) => void; onError: (message: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(feed.name);
  const [color, setColor] = useState(feed.color);
  const [busy, setBusy] = useState<"save" | "refresh" | "remove" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const run = async (kind: "save" | "refresh" | "remove") => {
    setBusy(kind);
    onError(null);
    try {
      if (kind === "save") {
        onChanged(await api.updateCalendarFeed(feed.id, { name, color }));
        setEditing(false);
      } else if (kind === "refresh") onChanged(await api.refreshCalendarFeed(feed.id));
      else onChanged((await api.removeCalendarFeed(feed.id)).feeds);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="calendar-feed" data-feed={feed.id}>
      <div className="calendar-feed-line">
        <span className="calendar-feed-color" style={{ "--feed": feed.color } as CSSProperties} aria-hidden />
        <span className="calendar-feed-main">
          <span className="calendar-feed-name">{feed.name}</span>
          <span className="calendar-feed-source">
            {feed.host}
            {feed.hint ? ` ${feed.hint}` : ""}
          </span>
        </span>
        <button type="button" className="icon-button small" aria-label="다시 받기" title="다시 받기" disabled={busy !== null} onClick={() => void run("refresh")}>
          {busy === "refresh" ? <span className="spinner small" /> : <Icon name="refresh" size={14} />}
        </button>
        <button type="button" className="icon-button small" aria-label="이름·색 바꾸기" title="이름·색 바꾸기" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          <Icon name="edit" size={14} />
        </button>
      </div>
      <div className={`calendar-feed-state${feed.error ? " failed" : ""}`}>
        {feed.error ? feed.error : feed.fetchedAt ? `${ago(feed.fetchedAt)} 받음 · 일정 ${feed.events}` : "아직 받지 못함"}
        {feed.error && feed.fetchedAt ? ` (${ago(feed.fetchedAt)} 받은 것을 보여 줍니다)` : ""}
      </div>
      {editing ? (
        <div className="calendar-feed-edit">
          <label className="calendar-field">
            <span>이름</span>
            <input className="sheet-input" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          </label>
          <Swatches value={color} onChange={setColor} label="색" />
          <div className="calendar-actions">
            <button type="button" className="button small primary" disabled={busy !== null || !name.trim()} onClick={() => void run("save")}>
              저장
            </button>
            {confirming ? (
              <>
                <button type="button" className="button small danger" disabled={busy !== null} onClick={() => void run("remove")}>
                  연결 끊기
                </button>
                <button type="button" className="text-button" onClick={() => setConfirming(false)}>
                  취소
                </button>
              </>
            ) : (
              <button type="button" className="text-button danger" onClick={() => setConfirming(true)}>
                연결 끊기…
              </button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function CalendarFeedsSheet({ api, onClose, onChanged, onToast }: { api: Api; onClose: () => void; onChanged: (feeds: CalendarFeedView[]) => void; onToast: (text: string) => void }) {
  const [feeds, setFeeds] = useState<CalendarFeedView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api
      .calendarFeeds()
      .then((result) => setFeeds(result.feeds))
      .catch((reason: Error) => setError(reason.message));
  }, [api]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const used = new Set((feeds ?? []).map((feed) => feed.color.toUpperCase()));
  const nextColor = color || CALENDAR_COLORS.find((entry) => !used.has(entry)) || CALENDAR_COLORS[0];

  const update = (next: CalendarFeedView[] | CalendarFeedView) => {
    const list = Array.isArray(next) ? next : (feeds ?? []).map((feed) => (feed.id === next.id ? next : feed));
    setFeeds(list);
    onChanged(list);
  };

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      const feed = await api.addCalendarFeed({ url, name, color: nextColor });
      const list = [...(feeds ?? []), feed];
      setFeeds(list);
      onChanged(list);
      // The address leaves this screen as soon as the gateway has it.
      setUrl("");
      setName("");
      setColor("");
      onToast(`'${feed.name}' 캘린더를 연결했습니다. 주소는 이 컴퓨터에만 있습니다.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAdding(false);
    }
  };

  return (
    <aside className="appearance-sheet calendar-sheet" aria-label="캘린더 연결">
      <div className="sheet-head">
        <h2>캘린더 연결</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="닫기">
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="sheet-body">
        <p className="sheet-hint">흐름의 하루·주·달에 캘린더 일정을 작업 기록과 함께 보여 줍니다. 일정은 읽기만 하고, 10분마다 새로 받습니다.</p>
        {error ? (
          <div className="notice notice-error compact" role="alert">
            {error}
          </div>
        ) : null}
        <section className="sheet-section" aria-label="연결한 캘린더">
          <div className="sheet-label">연결한 캘린더</div>
          {!feeds ? (
            <p className="sheet-hint">불러오는 중…</p>
          ) : feeds.length ? (
            <ul className="calendar-feeds">
              {feeds.map((feed) => (
                <FeedRow key={feed.id} api={api} feed={feed} onChanged={update} onError={setError} />
              ))}
            </ul>
          ) : (
            <p className="sheet-hint">아직 없습니다.</p>
          )}
        </section>
        <section className="sheet-section" aria-label="새 캘린더">
          <div className="sheet-label">새 캘린더</div>
          <ol className="calendar-steps">
            <li>Google 캘린더 웹에서 ⚙ 설정을 엽니다.</li>
            <li>왼쪽 '내 캘린더의 설정'에서 캘린더를 고릅니다.</li>
            <li>'캘린더 통합'의 'iCal 형식의 비밀 주소'를 복사해 아래에 붙여 넣습니다.</li>
          </ol>
          <p className="sheet-hint">다른 서비스의 .ics·webcal 주소도 됩니다. 주소는 이 컴퓨터의 앱 데이터 폴더에만 저장되고, 저장한 뒤에는 화면에 다시 보이지 않습니다.</p>
          <label className="calendar-field">
            <span>iCal 주소</span>
            <input
              className="sheet-input"
              type="password"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && url.trim() && !adding && void add()}
              placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
              spellCheck={false}
              autoComplete="off"
              name="calendar-ical-address"
            />
          </label>
          <label className="calendar-field">
            <span>이름</span>
            <input className="sheet-input" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="비우면 캘린더의 이름" />
          </label>
          <Swatches value={nextColor} onChange={setColor} label="새 캘린더의 색" />
          <div className="calendar-actions">
            <button type="button" className="button small primary" disabled={!url.trim() || adding} onClick={() => void add()}>
              {adding ? <span className="spinner small" /> : null} 연결
            </button>
          </div>
        </section>
      </div>
    </aside>
  );
}
