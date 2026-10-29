import { isUnseen, type ProjectEvent, type ProjectStage, type Session, type Work } from "@workbench/contracts";

// The project page's small rules, kept apart from the screen so they are tested on data.

/** A stage's look by its name; a name not in the settings (renamed since) has no colour. */
export function stageOf(stages: ProjectStage[], name: string | null): ProjectStage | null {
  if (!name) return null;
  return stages.find((stage) => stage.name === name) ?? { name, color: "#8b8d98" };
}

/** "3시간 12분", "45분", "1분 미만". */
export function duration(ms: number): string {
  if (ms < 60_000) return "1분 미만";
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}시간${rest ? ` ${rest}분` : ""}` : `${rest}분`;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** Events grouped by day, newest first: 오늘, 어제, then "10월 27일 (월)". */
export function eventDays(events: ProjectEvent[], now = Date.now()): { label: string; events: ProjectEvent[] }[] {
  const startOf = (at: number) => {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const today = startOf(now);
  const groups = new Map<number, ProjectEvent[]>();
  for (const event of [...events].sort((a, b) => b.at - a.at)) {
    const day = startOf(event.at);
    groups.set(day, [...(groups.get(day) ?? []), event]);
  }
  return [...groups.entries()].map(([day, list]) => {
    const date = new Date(day);
    const label = day === today ? "오늘" : day === today - 86_400_000 ? "어제" : `${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEKDAYS[date.getDay()]})`;
    return { label, events: list };
  });
}

/** A tag as compared for "the same tag": any case, `-`, `_` and spaces alike, without `#`. */
const tagKey = (tag: string) => tag.replace(/^#/, "").trim().toLowerCase().replace(/[-_\s]+/g, "_");

/**
 * Tags typed on the project page, each in the spelling already used (vault, other projects) when
 * there is one, so one tag does not split into several ("workflow-engineering" → "Workflow_Engineering").
 */
export function knownTags(typed: string, known: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const tag of known) if (!byKey.has(tagKey(tag))) byKey.set(tagKey(tag), tag);
  const out: string[] = [];
  for (const raw of typed.split(/[\s,]+/)) {
    const tag = raw.replace(/^#/, "").trim();
    if (!tag) continue;
    const spelled = byKey.get(tagKey(tag)) ?? tag;
    if (!out.some((entry) => tagKey(entry) === tagKey(spelled))) out.push(spelled);
  }
  return out;
}

const SEEN_KEY = "workbench.projectSeen";

/** When the person last left this project's page (null: never), kept on this device. */
export function projectSeenAt(workId: string): number | null {
  try {
    const value = (JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>)[workId];
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

/** Remember leaving a project's page now; the next visit marks what came after ("지난번 본 뒤"). */
export function markProjectSeen(workId: string, at = Date.now()) {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
    seen[workId] = at;
    // The 300 most recent are enough.
    const kept = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 300);
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or off: the page just shows no "지난번 본 뒤".
  }
}

/**
 * The session "이어서" opens: one waiting for approval, else one with an error, else an unread
 * answer, else the one last open — newest first within each.
 */
export function continueSession(work: Work, sessions: Session[]): Session | null {
  const live = sessions.filter((session) => session.workId === work.id && !session.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    live.find((session) => session.status === "awaitingApproval") ??
    live.find((session) => session.status === "error" || Boolean(session.lastError)) ??
    live.find(isUnseen) ??
    live.find((session) => session.id === work.activeSessionId) ??
    live[0] ??
    null
  );
}

/** The sessions as the page lists them: those needing the user first, then the most recent. */
export function sessionOrder(sessions: Session[]): Session[] {
  const rank = (session: Session) => (session.status === "awaitingApproval" ? 0 : session.status === "error" || session.lastError ? 1 : isUnseen(session) ? 2 : session.status === "idle" ? 4 : 3);
  return [...sessions].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

/** `[[가을 특강]]` → `가을 특강` for showing; plain text stays. */
export const linkLabel = (value: string) => value.replace(/^\[\[|\]\]$/g, "").split("|").pop()!.trim();

/** What a person types into "관련" becomes a wikilink unless it already is one or is an address. */
export const asLink = (value: string) => {
  const text = value.trim();
  return !text || /^\[\[.*\]\]$/.test(text) || /^[a-z]+:\/\//i.test(text) ? text : `[[${text}]]`;
};
