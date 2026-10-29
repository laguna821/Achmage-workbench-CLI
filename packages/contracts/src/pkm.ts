// Notion-like organisation with an Obsidian vault mirror (design 워크스테이션-다음설계 §4).
// The vault is read only for Workbench: it is scanned and drawn, never written.

import type { DocFormat, Provider, SessionStatus } from "./index.ts";

/** A colour per app theme, as the vault's Notebook Navigator and the user's border add-on give it. */
export type ThemedColor = { light: string | null; dark: string | null };

/** A gradient border (border add-on): start → end, with dark-theme colours when set. */
export type BorderStyle = { start: ThemedColor; end: ThemedColor; radius: number | null };

/** One folder of the vault mirror; `path` is relative to the vault ("" is the vault itself). */
export type VaultFolder = {
  path: string;
  name: string;
  /** Notes directly inside. */
  own: number;
  /** Notes in the folders below (not counting `own`). */
  below: number;
  color: ThemedColor;
  background: ThemedColor;
  /** An icon name the UI knows (mapped from Notebook Navigator's icon ids), or null. */
  icon: string | null;
  /** Pinned notes (Notebook Navigator) inside this folder. */
  pinned: number;
  children: VaultFolder[];
};

/** Group and folder borders as the border add-on draws them, already resolved per theme. */
export type VaultBorders = {
  groups: { id: string; name: string; folders: string[]; style: BorderStyle }[];
  folders: Record<string, BorderStyle>;
  showGroups: boolean;
  showFolders: boolean;
  suppressNested: boolean;
};

export type VaultStatus = {
  /** The attached vault folder, or null. */
  path: string | null;
  name: string | null;
  /** Why the vault cannot be shown (missing folder…), or null. */
  problem: string | null;
  /** A vault folder found on this computer, offered when none is attached. */
  suggested: string | null;
  notes: number;
  folders: number;
  /** Notebook Navigator settings were read (colours, icons, pins, hidden folders). */
  navigator: boolean;
  /** The border add-on's settings were read. */
  borders: boolean;
  /** Bumped on every change seen in the vault. */
  version: number;
  scannedAt: number | null;
};

export type VaultTree = {
  status: VaultStatus;
  root: VaultFolder | null;
  borders: VaultBorders | null;
  /** Notes pinned in Notebook Navigator (vault-relative paths), and its shortcuts. */
  pinned: { path: string; title: string }[];
  shortcuts: { path: string; title: string; kind: "note" | "folder" }[];
  /** Tag colours from Notebook Navigator (lower-case tag → colour). */
  tagColors: Record<string, string>;
};

/** One card of a card list (Notebook Navigator style): a vault note, a page, a session or a work. */
export type PkmCard = {
  kind: "note" | "page" | "session" | "work";
  /** Note: vault-relative path; page: artifact id; session / work: their id. */
  id: string;
  title: string;
  /** The first lines after the front matter (notes, pages) or the latest reply (sessions, works). */
  excerpt: string;
  tags: string[];
  date: number | null;
  /** created: the note's "date created"; modified: the file's time; activity: the last reply or change. */
  dateKind: "created" | "modified" | "activity";
  /** The first picture: a vault image (vault-relative path), an image next to a page, or a web address. */
  thumb: { vault: string } | { page: string; src: string } | { url: string } | null;
  /** Pinned in Notebook Navigator (notes) or in the sidebar (works, sessions). */
  pinned: boolean;
  /** The DIKM stage written in the note (`DIKM_단계:`), when there is one. */
  stage: string | null;
  provider?: Provider;
  status?: SessionStatus;
  format?: DocFormat;
  workId?: string;
  /** Sessions given this note (notes); sessions of the work (works). */
  sessions?: number;
  /** Where it is, for the line under the title (a note's folder, a session's work). */
  where?: string;
};

export type CardList = {
  title: string;
  crumbs: string[];
  cards: PkmCard[];
  /** Cards that matched before the list was cut short. */
  total: number;
  /** Vault folders: notes of subfolders are included. */
  descendants?: boolean;
  /** A saved view grouped by something other than the date: its groups in order ("값 없음" last). */
  groups?: { label: string; ids: string[] }[];
  /** A saved view's query that could not be read. */
  problems?: string[];
};

// ── saved views (virtual folders) ───────────────────────────────────────────────────────────

/** A saved query shown as a virtual folder under "보기". No model is ever asked. */
export type PkmView = {
  id: string;
  name: string;
  /** e.g. `#AI_교육 ."DIKM_단계:"="🔵 I" @last7d`, `engine:codex status:running`. */
  query: string;
  /** "date" (default), "engine", "status", "kind", or a front matter key such as `DIKM_단계:`. */
  groupBy: string | null;
};

export type ViewTerm = { not: boolean } & (
  | { kind: "tag"; tag: string }
  /** value null: the key has a value; "": it has none ("값 없음"). */
  | { kind: "prop"; key: string; value: string | null }
  | { kind: "date"; spec: "today" | "yesterday" | "thisweek" | "thismonth" | `last${number}d` }
  | { kind: "engine"; engine: "claude" | "codex" }
  | { kind: "status"; status: "running" | "idle" | "error" | "approval" | "unseen" }
  | { kind: "type"; type: PkmCard["kind"] }
  | { kind: "text"; text: string }
);

const STATUS_WORDS: Record<string, Extract<ViewTerm, { kind: "status" }>["status"]> = {
  running: "running", active: "running", 진행: "running", idle: "idle", 대기: "idle", error: "error", 오류: "error",
  approval: "approval", attention: "approval", 확인: "approval", unseen: "unseen", new: "unseen", 새답: "unseen",
};
const TYPE_WORDS: Record<string, PkmCard["kind"]> = { note: "note", 노트: "note", page: "page", 페이지: "page", session: "session", 세션: "session", work: "work", 작업: "work" };

/** Words of a query: spaces split, double quotes keep spaces (also inside `."key"="value"`). */
function words(query: string) {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of query) {
    if (character === '"') quoted = !quoted;
    if (!quoted && /\s/.test(character)) {
      if (current) out.push(current);
      current = "";
    } else current += character;
  }
  if (current) out.push(current);
  return out;
}

const unquoteWord = (text: string) => (text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).replace(/\\"/g, '"') : text);

/**
 * Read a view query (Notebook Navigator's syntax plus `engine:` and `status:`): `#tag`,
 * `."key"="value"` (or `."key"` = has a value, `."key"=""` = has none), `@today` `@yesterday`
 * `@thisweek` `@thismonth` `@last7d`, `engine:codex`, `status:running|idle|error|approval|unseen`,
 * `kind:note|page|session|work`; other words match titles. `-` in front negates.
 */
export function parseViewQuery(query: string): { terms: ViewTerm[]; problems: string[] } {
  const terms: ViewTerm[] = [];
  const problems: string[] = [];
  for (const raw of words(query)) {
    const not = raw.length > 1 && raw.startsWith("-");
    const word = not ? raw.slice(1) : raw;
    if (word.startsWith("#") && word.length > 1) terms.push({ not, kind: "tag", tag: word.slice(1) });
    else if (word.startsWith(".") && word.length > 1) {
      const match = /^\.("(?:[^"\\]|\\.)*"|[^=]+)(?:=("(?:[^"\\]|\\.)*"|.*))?$/.exec(word);
      if (!match) problems.push(word);
      else terms.push({ not, kind: "prop", key: unquoteWord(match[1]!), value: match[2] === undefined ? null : unquoteWord(match[2]) });
    } else if (word.startsWith("@")) {
      const spec = word.slice(1).toLowerCase();
      if (spec === "today" || spec === "yesterday" || spec === "thisweek" || spec === "thismonth" || /^last\d{1,4}d$/.test(spec)) terms.push({ not, kind: "date", spec: spec as Extract<ViewTerm, { kind: "date" }>["spec"] });
      else problems.push(word);
    } else if (/^engine:/i.test(word)) {
      const engine = word.slice(7).toLowerCase();
      if (engine === "claude" || engine === "codex") terms.push({ not, kind: "engine", engine });
      else problems.push(word);
    } else if (/^status:/i.test(word)) {
      const status = STATUS_WORDS[word.slice(7).toLowerCase()];
      if (status) terms.push({ not, kind: "status", status });
      else problems.push(word);
    } else if (/^kind:/i.test(word)) {
      const type = TYPE_WORDS[word.slice(5).toLowerCase()];
      if (type) terms.push({ not, kind: "type", type });
      else problems.push(word);
    } else terms.push({ not, kind: "text", text: unquoteWord(word) });
  }
  return { terms, problems };
}

/** The time range of a date term (`[from, to)`, local days; weeks start on Monday). */
export function dateRange(spec: Extract<ViewTerm, { kind: "date" }>["spec"], now = Date.now()): [number, number] {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  if (spec === "today") return [today, Infinity];
  if (spec === "yesterday") return [today - 86_400_000, today];
  if (spec === "thisweek") return [today - ((day.getDay() + 6) % 7) * 86_400_000, Infinity];
  if (spec === "thismonth") return [new Date(day.getFullYear(), day.getMonth(), 1).getTime(), Infinity];
  return [now - Number(spec.slice(4, -1)) * 86_400_000, Infinity];
}

// ── rules (조건 → 배치) ─────────────────────────────────────────────────────────────────────

/**
 * One ordered rule for new works; the first that matches places the work. Conditions left empty
 * match anything. `then.folder` is an app folder path ("강의/2026"); `{disk}` means the name of the
 * folder the work's folder sits in ("디스크 위치대로").
 */
export type PkmRule = {
  id: string;
  name: string;
  enabled: boolean;
  when: { cwdPrefix: string | null; engine: "claude" | "codex" | null; format: DocFormat | null };
  then: { folder: string | null; tag: string | null; pin: boolean };
};

export const DISK_FOLDER = "{disk}";

/** Where a rule put a work (shown on its row: "이 규칙으로 여기 있음"). */
export type RulePlacement = { ruleId: string; ruleName: string; at: number };

/** One line of "미리보기": what a rule would do to a work. */
export type RuleChange = {
  workId: string;
  title: string;
  ruleId: string;
  ruleName: string;
  /** Folder paths, null = "분류 없음". */
  from: string | null;
  to: string | null;
  tag: string | null;
  pin: boolean;
  /** Ticked at first: works not filed yet. */
  suggested: boolean;
};

/** A vault note opened read-only. */
export type VaultNote = {
  path: string;
  absolutePath: string;
  title: string;
  /** The text after the front matter. */
  body: string;
  /** Front matter keys exactly as spelled, with their values. */
  properties: [string, string[] | null][];
  tags: string[];
  date: number | null;
  /** `[[link]]` targets → vault paths (null when no such note). */
  links: Record<string, string | null>;
  /** `![[embed]]` and `![](path)` images → vault-relative image paths (null when missing). */
  embeds: Record<string, string | null>;
  /** Sessions this note was given to. */
  sessions: number;
};

/**
 * A page template: app-wide (gateway data folder), of one work (`.workbench/templates/`) or of the
 * vault (`90. Settings/91. Templates/`, read only). Copied into the work folder as a new page.
 */
export type PageTemplate = {
  /** `<source>:<file name>` */
  id: string;
  source: "global" | "work" | "vault";
  name: string;
  /** Keys followed by a list of options (and `DIKM_단계:`): asked in the picker, empty by default. */
  choices: { key: string; options: string[] }[];
  /** Templater commands (`<% %>`) in it: kept as text, never run. */
  templater: boolean;
};

/** "인사이트 초안": a finished session as a DIKM note draft (no model), checked before it can be published. */
export type InsightDraft = {
  sessionId: string;
  title: string;
  summary: string;
  /** The whole draft: the vault template's front matter (keys spelled exactly) and a body. */
  text: string;
  /** The template keys every published draft must keep, in order. */
  keys: string[];
  /** The vault template the keys came from (vault-relative), or null (built-in DIKM keys). */
  template: string | null;
  /** Why it cannot be published as it is (empty when it can). */
  problems: string[];
};

/** What the UI shows of the PKM layer; fetched again when a `pkm.changed` event arrives. */
export type PkmState = {
  vault: VaultStatus;
  views: (PkmView & { count: number })[];
  rules: PkmRule[];
  placements: Record<string, RulePlacement>;
  /** Vault notes pinned to each work (vault-relative paths): in its sessions' context card. */
  pins: Record<string, string[]>;
};

/** Gateway scopes a `pkm.changed` event names. */
export type PkmScope = "vault" | "views" | "rules" | "pins" | "insights";
