// Calendar feeds on home "흐름": calendars the user subscribes to by their iCal address (Google
// Calendar's "iCal 형식의 비밀 주소", any .ics), shown read-only next to the work activity. The
// address is a secret: the gateway keeps it on this computer and never sends it back whole.

/** Colours offered for a feed (user data, applied inline). */
export const CALENDAR_COLORS = ["#2F6FD0", "#0F8C84", "#C98A1B", "#C2453D", "#7A5BC4", "#4F7A3A", "#6B7280"] as const;

/** A subscribed calendar as the screen sees it: never its address, only where it comes from. */
export type CalendarFeedView = {
  id: string;
  name: string;
  /** `#rrggbb` */
  color: string;
  /** The address's host, e.g. `calendar.google.com`. */
  host: string;
  /** A harmless part of the address to tell feeds apart (e.g. `…/basic.ics`), or "". */
  hint: string;
  addedAt: number;
  /** When the last copy was received (it may be older than the last attempt). */
  fetchedAt: number | null;
  /** Why the last attempt failed, in the user's words; null when it worked. */
  error: string | null;
  /** Events (a series counts once) in the last copy. */
  events: number;
};

/** What the form sends; an empty or missing `url` keeps the saved address. */
export type CalendarFeedInput = { name?: string; color?: string; url?: string };

/** One occurrence of a calendar event, read-only. */
export type CalendarEvent = {
  /** Unique per occurrence (the feed, the event's UID and its start). */
  id: string;
  feedId: string;
  title: string;
  location: string | null;
  /** Timed events: when it starts and ends (ms). All-day events: the screen's midnights. */
  start: number;
  end: number;
  /** All-day events: their days as `YYYY-MM-DD`, `to` exclusive; null for timed events. */
  days: { from: string; to: string } | null;
};

export type CalendarEventsView = { feeds: CalendarFeedView[]; events: CalendarEvent[] };
