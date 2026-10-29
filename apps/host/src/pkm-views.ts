import { dateRange, isUnseen, type PkmCard, type Session, type ViewTerm, type Work } from "@workbench/contracts";
import type { FrontmatterValue } from "./frontmatter.ts";
import { DIKM_STAGES } from "./pages.ts";

// Saved views: a query over vault notes, pages, sessions and works, read without any model.
// Each kind of thing answers only the terms that mean something for it (a note has no engine);
// a term that cannot apply never matches, and its negation always does.

export type ViewItem = {
  card: PkmCard;
  tags: string[];
  properties: [string, FrontmatterValue][];
  engines: Session["provider"][];
  statuses: Extract<ViewTerm, { kind: "status" }>["status"][];
};

const sameKey = (a: string, b: string) => a.trim().replace(/:$/, "").toLowerCase() === b.trim().replace(/:$/, "").toLowerCase();
const sameValue = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The statuses a session counts for in `status:` terms. */
export function sessionStatuses(session: Session): ViewItem["statuses"] {
  const out: ViewItem["statuses"] = [];
  if (session.status === "starting" || session.status === "running" || session.status === "interrupting") out.push("running");
  else if (session.status === "awaitingApproval") out.push("approval");
  else if (session.status === "error") out.push("error");
  else out.push("idle");
  if (isUnseen(session)) out.push("unseen");
  return out;
}

/** The values of a front matter key in an item (any spelling of a trailing colon, any case). */
export function propertyValues(item: Pick<ViewItem, "properties">, key: string): string[] | null {
  const entry = item.properties.find(([name]) => sameKey(name, key));
  return entry ? (entry[1] ?? []) : null;
}

/**
 * Cards a plain text term matches, from the search index (search.ts `cardMatches`: keys
 * `<kind>:<id>`); without one, the term is looked for in titles and excerpts.
 */
export type TextMatcher = (text: string) => ReadonlySet<string>;

function matches(item: ViewItem, term: ViewTerm, now: number, text: TextMatcher | null): boolean {
  switch (term.kind) {
    case "tag": {
      const wanted = term.tag.replace(/^#/, "").toLowerCase();
      return item.tags.some((tag) => {
        const lower = tag.replace(/^#/, "").toLowerCase();
        return lower === wanted || lower.startsWith(`${wanted}/`);
      });
    }
    case "prop": {
      const values = propertyValues(item, term.key);
      if (term.value === null) return Boolean(values?.some((value) => value.trim()));
      if (term.value === "") return !values?.some((value) => value.trim());
      return Boolean(values?.some((value) => sameValue(value, term.value!)));
    }
    case "date": {
      const [from, to] = dateRange(term.spec, now);
      return item.card.date !== null && item.card.date >= from && item.card.date < to;
    }
    case "engine":
      return item.engines.includes(term.engine);
    case "status":
      return item.statuses.includes(term.status);
    case "type":
      return item.card.kind === term.type;
    case "text": {
      if (text) return text(term.text).has(`${item.card.kind}:${item.card.id}`);
      const lower = term.text.toLowerCase();
      return item.card.title.toLowerCase().includes(lower) || item.card.excerpt.toLowerCase().includes(lower);
    }
  }
}

/** Items that meet every term (negated terms must not hold). Text terms use `text` (the search index) when given. */
export function filterItems(items: ViewItem[], terms: ViewTerm[], now = Date.now(), text: TextMatcher | null = null) {
  // One index lookup per text term, not per item.
  const cache = new Map<string, ReadonlySet<string>>();
  const lookup: TextMatcher | null = text
    ? (value) => {
        let found = cache.get(value);
        if (!found) {
          found = text(value);
          cache.set(value, found);
        }
        return found;
      }
    : null;
  return items.filter((item) => terms.every((term) => matches(item, term, now, lookup) !== term.not));
}

/** The kinds a query can return (a positive `kind:` narrows them; reading fewer sources is cheaper). */
export function kindsFor(terms: ViewTerm[]): Set<PkmCard["kind"]> {
  const wanted = terms.filter((term): term is Extract<ViewTerm, { kind: "type" }> => term.kind === "type" && !term.not).map((term) => term.type);
  return new Set(wanted.length ? wanted : ["note", "page", "session", "work"]);
}

const KIND_LABEL: Record<PkmCard["kind"], string> = { note: "노트", page: "페이지", session: "세션", work: "작업" };
const STATUS_LABEL: Record<ViewItem["statuses"][number], string> = { running: "진행 중", approval: "확인 필요", error: "오류", idle: "대기", unseen: "새 답" };

/**
 * Groups for a view grouped by something other than the date. A value that is missing stays
 * missing: such items go under "값 없음" (last), nothing is guessed to fill it.
 */
export function groupItems(items: ViewItem[], groupBy: string): { label: string; ids: string[] }[] {
  const groups = new Map<string, string[]>();
  const add = (label: string, item: ViewItem) => groups.set(label, [...(groups.get(label) ?? []), `${item.card.kind}:${item.card.id}`]);
  for (const item of items) {
    if (groupBy === "kind") add(KIND_LABEL[item.card.kind], item);
    else if (groupBy === "engine") add(item.engines[0] === "claude" ? "Claude" : item.engines[0] === "codex" ? "Codex" : "값 없음", item);
    else if (groupBy === "status") add(item.statuses.length ? STATUS_LABEL[item.statuses[0]!] : "값 없음", item);
    else add(propertyValues(item, groupBy)?.find((value) => value.trim())?.trim() ?? "값 없음", item);
  }
  // DIKM stages keep their own order (D · I · K · M · 보류); other values by name; "값 없음" last.
  const rank = (label: string) => (label === "값 없음" ? 2 : DIKM_STAGES.includes(label) ? 0 : 1);
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b) || (rank(a) === 0 ? DIKM_STAGES.indexOf(a) - DIKM_STAGES.indexOf(b) : a.localeCompare(b, "ko", { numeric: true })))
    .map(([label, ids]) => ({ label, ids }));
}

export const workEngines = (sessions: Session[]) => [...new Set(sessions.map((session) => session.provider))];
export const workStatuses = (sessions: Session[]) => [...new Set(sessions.flatMap(sessionStatuses))];
export const workTags = (work: Work) => work.tags ?? [];
