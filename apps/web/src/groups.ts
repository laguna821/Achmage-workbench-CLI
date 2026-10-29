import { NO_VALUE, groupKey, type DateBuckets, type GroupLook, type GroupRule } from "@workbench/contracts";
import { addMonths, dayNumber, daysInMonth, localDay, mondayOf, parseDayKey, type Day } from "./calendar.ts";

// Home's groups (프로젝트-내비게이터-그룹보기-설계 §3.2): items → groups by a key, as Notion and
// Obsidian Bases group. Plain functions over plain data, tested on their own: Korean periods for
// dates in the local time zone with weeks from Monday, values that are lists (an item shows in each
// of its groups), "값 없음" last, and the colour a group starts with — a leading emoji (so the
// vault's DIKM values 🟢 D · 🔵 I · 🟣 K · 🟠 M · ⬜ 보류 colour themselves), else the stage's or the
// folder's own colour, else none until the person picks one.

/**
 * How a key's values make groups:
 * - "choice": values with their own order and colours (stages, folders, states, engines, formats…);
 * - "text": by name; "number": by size; "checkbox": 예 · 아니오;
 * - "list": several values each (tags, list and link properties): an item is in each of its groups;
 * - "date": days ahead (마감일): 지남 · 오늘 · 내일 · 이번 주 · 다음 주 · 이번 달 · 다음 달 · 나중;
 * - "past": times gone by (최근 활동, 만든 날): 오늘 · 어제 · 이번 주 · 지난 주 · 이번 달 · 더 이전.
 * Both date kinds can also go by month or by week instead.
 */
export type KeyKind = "choice" | "text" | "number" | "checkbox" | "list" | "date" | "past";

export type KnownValue = { id: string; label: string; color?: string | null; depth?: number };

/** A key items can be grouped (and boards dragged) by. */
export type KeyDef<T> = {
  key: string;
  label: string;
  kind: KeyKind;
  /**
   * The item's values: ids for "choice", words, numbers as text, "true"/"false", dates as
   * "YYYY-MM-DD" (a time after it is ignored); for "past", times in ms.
   */
  values: (item: T) => readonly (string | number)[];
  /**
   * Values the key knows, in their order, with labels and colours: shown as groups even when
   * empty (stages, folders, states; a template field's options such as "높음 · 보통 · 낮음").
   */
  known?: readonly KnownValue[];
  /** How "값 없음" reads for this key ("폴더 밖", "조용함"…). */
  none?: string;
  /** Why a card cannot be dragged between this key's groups; null when it can. */
  fixed: string | null;
  /** A value as shown ("[[가을 특강]]" → "가을 특강"). */
  show?: (value: string) => string;
};

export type Group<T> = {
  id: string;
  label: string;
  /** The colour the group starts with (emoji, stage, folder), before the view's own. */
  color: string | null;
  items: T[];
  /** Folders: how deep in the tree. */
  depth: number;
};

export const AHEAD: { id: string; label: string }[] = [
  { id: "overdue", label: "지남" },
  { id: "today", label: "오늘" },
  { id: "tomorrow", label: "내일" },
  { id: "thisWeek", label: "이번 주" },
  { id: "nextWeek", label: "다음 주" },
  { id: "thisMonth", label: "이번 달" },
  { id: "nextMonth", label: "다음 달" },
  { id: "later", label: "나중" },
];

export const BEHIND: { id: string; label: string }[] = [
  { id: "today", label: "오늘" },
  { id: "yesterday", label: "어제" },
  { id: "thisWeek", label: "이번 주" },
  { id: "lastWeek", label: "지난 주" },
  { id: "thisMonth", label: "이번 달" },
  { id: "earlier", label: "더 이전" },
];

const lastOfMonth = (day: Day) => dayNumber({ y: day.y, m: day.m, d: daysInMonth(day.y, day.m) });

/** A day ahead as a period of `today` (first match wins: a Monday tomorrow is "내일", not "다음 주"). */
export function aheadPeriod(day: Day, today: Day): string {
  const at = dayNumber(day);
  const now = dayNumber(today);
  if (at < now) return "overdue";
  if (at === now) return "today";
  if (at === now + 1) return "tomorrow";
  const sunday = dayNumber(mondayOf(today)) + 6;
  if (at <= sunday) return "thisWeek";
  if (at <= sunday + 7) return "nextWeek";
  if (at <= lastOfMonth(today)) return "thisMonth";
  if (at <= lastOfMonth(addMonths({ y: today.y, m: today.m, d: 1 }, 1))) return "nextMonth";
  return "later";
}

/** A day gone by as a period of `today`; a day after today (another clock) counts as today. */
export function pastPeriod(day: Day, today: Day): string {
  const at = dayNumber(day);
  const now = dayNumber(today);
  if (at >= now) return "today";
  if (at === now - 1) return "yesterday";
  const monday = dayNumber(mondayOf(today));
  if (at >= monday) return "thisWeek";
  if (at >= monday - 7) return "lastWeek";
  if (at >= dayNumber({ y: today.y, m: today.m, d: 1 })) return "thisMonth";
  return "earlier";
}

/** The local day of a value: "2026-10-29", "2026-10-29T14:30", or a time in ms. Null when it is none. */
export function dayOf(value: string | number): Day | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? localDay(value) : null;
  return parseDayKey(value.trim().slice(0, 10));
}

const two = (value: number) => String(value).padStart(2, "0");

function bucketLabel(id: string, dates: DateBuckets, kind: "date" | "past", today: Day): string {
  if (dates === "period") return (kind === "date" ? AHEAD : BEHIND).find((entry) => entry.id === id)?.label ?? id;
  if (dates === "month") {
    const [y, m] = id.split("-").map(Number) as [number, number];
    return y === today.y ? `${m}월` : `${y}년 ${m}월`;
  }
  const day = parseDayKey(id)!;
  return `${day.y === today.y ? "" : `${day.y}년 `}${day.m}월 ${day.d}일 주`;
}

function bucketOf(day: Day, dates: DateBuckets, kind: "date" | "past", today: Day): string {
  if (dates === "month") return `${day.y}-${two(day.m)}`;
  if (dates === "week") {
    const monday = mondayOf(day);
    return `${monday.y}-${two(monday.m)}-${two(monday.d)}`;
  }
  return kind === "date" ? aheadPeriod(day, today) : pastPeriod(day, today);
}

const clean = (values: readonly (string | number)[]) => [...new Set(values.map((value) => (typeof value === "number" ? value : value.trim())).filter((value) => value !== ""))];

/** The groups an item goes in under a key (`[""]` for none): one, or one per value for lists. */
export function idsOf<T>(def: KeyDef<T>, item: T, dates: DateBuckets, today: Day): string[] {
  const values = clean(def.values(item));
  if (!values.length) return [NO_VALUE];
  if (def.kind === "date" || def.kind === "past") {
    const day = dayOf(values[0]!);
    return day ? [bucketOf(day, dates, def.kind, today)] : [NO_VALUE];
  }
  if (def.kind === "checkbox") return [/^true$/i.test(String(values[0])) ? "true" : "false"];
  if (def.kind === "list") return values.map(String);
  return [String(values[0])];
}

const EMOJI: [string[], string][] = [
  [["🟢", "🟩", "💚"], "#30a46c"],
  [["🔵", "🟦", "💙"], "#3e63dd"],
  [["🟣", "🟪", "💜"], "#8e4ec6"],
  [["🟠", "🟧", "🧡"], "#f76b15"],
  [["🔴", "🟥", "❤"], "#e5484d"],
  [["🟡", "🟨", "💛"], "#e2a400"],
  [["⬜", "⚪", "⬛", "⚫", "◻", "◽", "🩶", "🤍", "🖤"], "#8b8d98"],
];

/** Which of the colour emoji a value starts with (its place in the list above), or -1. */
const emojiRank = (text: string) => {
  const start = text.trimStart();
  return EMOJI.findIndex(([marks]) => marks.some((mark) => start.startsWith(mark)));
};

/** The colour a value's leading emoji stands for (🟢 green, 🔵 blue, 🟣 purple, 🟠 orange, 🔴 red, 🟡 yellow, ⬜ grey), or null. */
export function emojiColor(text: string): string | null {
  const rank = emojiRank(text);
  return rank < 0 ? null : EMOJI[rank]![1];
}

// One collator for every comparison (a new one per call is slow with hundreds of items).
const collator = new Intl.Collator("ko", { numeric: true });
const byName = (a: string, b: string) => collator.compare(a, b);

/**
 * Names in order; values that start with a colour emoji come first, in the order the emoji are
 * listed (🟢 🔵 🟣 🟠 🔴 🟡 ⬜ — so the vault's DIKM values read D · I · K · M · 보류).
 */
export const byLabel = (a: string, b: string) => {
  const x = emojiRank(a);
  const y = emojiRank(b);
  if (x !== y) return x < 0 ? 1 : y < 0 ? -1 : x - y;
  return byName(a, b);
};

/** Options a template field's hint lists ("높음 · 보통 · 낮음", "예: 강의, 연구"), in its order; none for a plain sentence. */
export function hintOptions(hint: string | undefined): string[] {
  if (!hint) return [];
  const parts = hint
    .replace(/^\s*(예|예시|e\.g\.)\s*[:：)]\s*/i, "")
    .split(/\s*[·,，、]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length >= 2 && parts.length <= 20 && parts.every((part) => [...part].length <= 16) ? [...new Set(parts)] : [];
}

/**
 * Items in groups by a key. Values the key knows (stages, folders, states, the periods of a date)
 * come in their own order and stay as (empty) groups unless `hideEmpty`; other values follow in
 * their natural order (names, numbers, months and weeks by time); "값 없음" is always last.
 * Lists put an item in each of its groups. `reverse` turns the order round ("값 없음" stays last).
 */
export function groupItems<T>(items: readonly T[], def: KeyDef<T>, rule: Pick<GroupRule, "dates" | "reverse" | "hideEmpty"> | null, today: Day): Group<T>[] {
  const dates = rule?.dates ?? "period";
  const members = new Map<string, T[]>();
  for (const item of items) {
    for (const id of idsOf(def, item, dates, today)) {
      const list = members.get(id);
      if (list) list.push(item);
      else members.set(id, [item]);
    }
  }
  const show = (id: string) => (def.show ? def.show(id) : id);
  const dated = def.kind === "date" || def.kind === "past";
  const known: KnownValue[] =
    def.kind === "checkbox"
      ? [
          { id: "true", label: "예" },
          { id: "false", label: "아니오" },
        ]
      : dated
        ? dates === "period"
          ? (def.kind === "date" ? AHEAD : BEHIND).map((entry) => ({ ...entry }))
          : []
        : [...(def.known ?? [])];
  const knownIds = new Set(known.map((entry) => entry.id));
  const extra = [...members.keys()].filter((id) => id !== NO_VALUE && !knownIds.has(id));
  if (def.kind === "number") extra.sort((a, b) => Number(a) - Number(b) || byName(a, b));
  else if (def.kind === "date") extra.sort();
  else if (def.kind === "past") extra.sort().reverse();
  else extra.sort((a, b) => byLabel(show(a), show(b)));
  const label = (id: string) => (def.kind === "date" || def.kind === "past" ? bucketLabel(id, dates, def.kind, today) : show(id));
  let groups: Group<T>[] = [
    ...known.map((entry) => ({ id: entry.id, label: entry.label, color: emojiColor(entry.label) ?? entry.color ?? null, items: members.get(entry.id) ?? [], depth: entry.depth ?? 0 })),
    ...extra.map((id) => ({ id, label: label(id), color: emojiColor(label(id)), items: members.get(id)!, depth: 0 })),
  ];
  if (rule?.reverse) groups.reverse();
  const none = members.get(NO_VALUE);
  // Keys with known values keep an empty "값 없음" too (a board's place to clear a value).
  if (none || (known.length && def.kind !== "checkbox")) groups.push({ id: NO_VALUE, label: def.none ?? "값 없음", color: null, items: none ?? [], depth: 0 });
  if (rule?.hideEmpty) groups = groups.filter((group) => group.items.length);
  return groups;
}

export type NestedGroup<T> = Group<T> & { sub: Group<T>[] | null };

/** Groups inside groups (tables, lists, cards): only the inner groups that hold something. */
export function nestGroups<T>(groups: Group<T>[], sub: KeyDef<T> | null, rule: GroupRule | null, today: Day): NestedGroup<T>[] {
  return groups.map((group) => ({ ...group, sub: sub && rule ? groupItems(group.items, sub, { ...rule, hideEmpty: true }, today) : null }));
}

export type Board<T> = { columns: Group<T>[]; lanes: Group<T>[] | null; cell: (column: string, lane: string | null) => T[] };

/** A board: columns by the group key and, with a subgroup, rows (swimlanes) across all of them. */
export function boardOf<T>(items: readonly T[], column: KeyDef<T>, columnRule: GroupRule | null, lane: KeyDef<T> | null, laneRule: GroupRule | null, today: Day): Board<T> {
  const columns = groupItems(items, column, columnRule, today);
  if (!lane || !laneRule) return { columns, lanes: null, cell: (id) => columns.find((group) => group.id === id)?.items ?? [] };
  const lanes = groupItems(items, lane, laneRule, today);
  const cells = new Map<string, T[]>();
  for (const item of items) {
    const across = idsOf(lane, item, laneRule.dates ?? "period", today);
    for (const at of idsOf(column, item, columnRule?.dates ?? "period", today)) {
      for (const row of across) {
        const key = `${at}\n${row}`;
        const list = cells.get(key);
        if (list) list.push(item);
        else cells.set(key, [item]);
      }
    }
  }
  return { columns, lanes, cell: (id, row) => cells.get(`${id}\n${row ?? NO_VALUE}`) ?? [] };
}

/** What a key sorts by: a name, a number, or a time (ms or "YYYY-MM-DD…"); null sorts last. */
export type SortDef<T> = { key: string; label: string; value: (item: T) => string | number | null };

/** Items in order; empty values last whichever way, ties by `tie` (a name). */
export function sortItems<T>(items: readonly T[], def: SortDef<T> | null, dir: "asc" | "desc", tie: (item: T) => string): T[] {
  if (!def) return [...items];
  const sign = dir === "asc" ? 1 : -1;
  const keyed = items.map((item) => ({ item, value: def.value(item) }));
  keyed.sort((a, b) => {
    const x = a.value;
    const y = b.value;
    const emptyX = x === null || x === "";
    const emptyY = y === null || y === "";
    if (emptyX || emptyY) return emptyX === emptyY ? byName(tie(a.item), tie(b.item)) : emptyX ? 1 : -1;
    const order = typeof x === "number" && typeof y === "number" ? x - y : byName(String(x), String(y));
    return order * sign || byName(tie(a.item), tie(b.item));
  });
  return keyed.map((entry) => entry.item);
}

/** What dropping an item on another group writes (null clears the value), or why it cannot. */
export type Move = { ok: true; value: string | null } | { ok: false; reason: string };

export function moveOf<T>(def: KeyDef<T>, item: T, target: string): Move {
  if (def.fixed) return { ok: false, reason: def.fixed };
  if (def.kind === "list" && clean(def.values(item)).length > 1) return { ok: false, reason: `'${def.label}'에 값이 여럿이라 끌어서 바꾸지 않습니다. 프로젝트 속성에서 고칩니다.` };
  return { ok: true, value: target === NO_VALUE ? null : target };
}

/** A group's colour in a view: the person's pick, else what it starts with. */
export const colorOf = (look: GroupLook, key: string, group: Pick<Group<unknown>, "id" | "color">) => look.colors[groupKey(key, group.id)] ?? group.color;

/** The folded-group entry of a group (inside another one: both, a line apart). */
export const foldKey = (key: string, id: string, parent?: string) => (parent ? `${parent}\n${groupKey(key, id)}` : groupKey(key, id));

export { localDay };
