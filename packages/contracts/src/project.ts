import type { Provider } from "./index.ts";
import type { EngineReadNote, PkmCard } from "./pkm.ts";

// "프로젝트 = 노트 한 장": a work seen as one Markdown note. What people write (stage, tags, related,
// decisions, open questions, the rest of the text) lives in a real note file in the work folder; what
// its sessions did is counted when shown and never written into the file.

/** A stage a person gives a project (사람이 정하는 단계), as written in the note, with its colour. */
export type ProjectStage = {
  name: string;
  /** CSS colour (`#rrggbb`). */
  color: string;
  /** Setting this stage puts the project in the archive (앱 보관함). */
  archive?: boolean;
};

export const DEFAULT_STAGES: ProjectStage[] = [
  { name: "할일", color: "#e5484d" },
  { name: "진행중", color: "#3e63dd" },
  { name: "완료", color: "#30a46c" },
  { name: "보류", color: "#e2a400" },
  { name: "아카이브", color: "#8e4ec6", archive: true },
];

/** The note key the stage is written under. */
export const STAGE_KEY = "단계";

/** One line of the note's `## 결정` or `## 열린 질문` list. */
export type ProjectEntry = {
  /** Line number in the note file (0-based), to tick or remove that line. */
  line: number;
  text: string;
  /** Open questions only: `- [x]`. */
  done: boolean;
};

export type ProjectNote = {
  /** Where the note is, or will be once something is written. */
  path: string;
  exists: boolean;
  /** Front matter keys exactly as written, values as strings (the machine key `workbench_id` left out). */
  properties: [string, string[] | null][];
  stage: string | null;
  tags: string[];
  decisions: ProjectEntry[];
  questions: ProjectEntry[];
  /** The body after the front matter (the whole note text people read). */
  body: string;
  /** Why the note could not be read as one (broken front matter, unreadable file), or null. */
  problem: string | null;
  /** The note's latest recorded revision and who wrote it (an engine's write is shown with a way back). */
  revision: number | null;
  lastAuthor: "user" | "engine" | "external" | null;
  lastSessionId: string | null;
  artifactId: string | null;
};

/** Counted from the project's sessions and documents when shown (AI 0). */
/**
 * A place a break left something for the person (멈춘 곳): a session whose last turn broke off or
 * that keeps requests it did not send, a proposal a cut turn left, a link a failed turn paused.
 */
export type StoppedPlace = {
  kind: "session" | "proposal" | "link";
  /** What and why, e.g. "Codex · 초안 — 엔진이 멈춰 끊김 · 보내지 않은 요청 1개". */
  text: string;
  /** Where to go: the session (of a link, the one whose answer broke), the document and proposal. */
  sessionId: string | null;
  artifactId?: string | null;
  proposalId?: string | null;
  at: number;
};

export type ProjectFacts = {
  sessions: number;
  running: number;
  /** Sessions waiting for an approval (확인 필요). */
  attention: number;
  errors: number;
  /** What breaks left to do, newest first (멈춘 곳). */
  stopped: StoppedPlace[];
  unread: number;
  /** Pending proposals on its documents. */
  proposals: number;
  /** The newest session of each of these, to go there in one click. */
  attentionSessionId: string | null;
  errorSessionId: string | null;
  proposalId: string | null;
  proposalArtifactId: string | null;
  lastActivity: number | null;
  createdAt: number;
  engines: Partial<Record<Provider, number>>;
  models: string[];
  requests: number;
  /** Sum of finished turns' durations. */
  turnMs: number;
  files: number;
  revisions: { user: number; engine: number; external: number };
  schedules: number;
  worktrees: number;
  folder: string;
  branch: string | null;
};

/** One thing that happened in the project, taken from what is already recorded (AI 0). */
export type ProjectEvent = {
  id: string;
  at: number;
  kind: "request" | "revision" | "proposal" | "plan" | "handoff" | "link" | "worktree" | "stage" | "decision" | "question";
  text: string;
  sessionId: string | null;
  artifactId: string | null;
  proposalId?: string | null;
  /** Who: the person, an engine, or a program outside the app. */
  by: "user" | Provider | "external" | null;
  /** For "결정으로 남기기": the transcript item it came from. */
  itemId?: string | null;
};

export type ProjectPage = {
  workId: string;
  note: ProjectNote;
  facts: ProjectFacts;
  events: ProjectEvent[];
  /** The context card a new session of this project gets: what the engines are told. */
  card: string;
  stages: ProjectStage[];
  /** Vault notes its sessions' engines read by themselves, most read first ("엔진이 읽은 노트"). */
  readNotes?: EngineReadNote[];
  /** The properties panel: template fields first, then the note's other keys, each with its kind. */
  rows?: PropertyRow[];
  /** Property names to suggest when adding one (the vault's, other projects'), with their kinds. */
  knownKeys?: { key: string; type: PropertyType }[];
  noteTemplate?: { folderId: string; folderName: string } | null;
};

/** Classification-folder templates seed new notes only; ancestors supply the fallback. */
export type FolderNoteTemplate = {
  folderId: string;
  own: string | null;
  effective: { folderId: string; folderName: string; markdown: string } | null;
  fields: PropertyField[];
};

/** The Achmage work a project note names (`achmage_work`), as the user's Achmage runtime describes it (read-only). */
export type AchmageBrief = {
  workId: string;
  /** False: the runtime does not know that work. */
  found: boolean;
  title: string | null;
  lastCapturedAt: number | null;
  devices: string[];
  /** A summary from its context, when the runtime had one to give. */
  summary: string | null;
};

/**
 * A property's kind, as Obsidian has them (`.obsidian/types.json`: text, multitext, number,
 * checkbox, date, datetime, tags, aliases) plus the project's stage and its links ("관련").
 */
export type PropertyType = "text" | "list" | "number" | "checkbox" | "date" | "datetime" | "tags" | "links" | "stage";

export const PROPERTY_TYPES: { type: PropertyType; label: string }[] = [
  { type: "text", label: "텍스트" },
  { type: "list", label: "목록" },
  { type: "number", label: "숫자" },
  { type: "checkbox", label: "체크박스" },
  { type: "date", label: "날짜" },
  { type: "datetime", label: "날짜와 시간" },
  { type: "tags", label: "태그" },
  { type: "links", label: "링크" },
  { type: "stage", label: "단계" },
];

/** One field of the properties template: every project shows it (empty until filled). */
export type PropertyField = { key: string; type: PropertyType; hint?: string };

/** The template every project starts from (the user can change it, or take one from a Markdown file's front matter). */
export const DEFAULT_PROPERTY_TEMPLATE: PropertyField[] = [
  { key: STAGE_KEY, type: "stage" },
  { key: "tags", type: "tags" },
  { key: "종류", type: "list", hint: "예: 강의, 연구, 개발, 행정, 글쓰기" },
  { key: "시작일", type: "date" },
  { key: "마감일", type: "date" },
  { key: "중요도", type: "text", hint: "높음 · 보통 · 낮음" },
  { key: "목표", type: "text", hint: "이 프로젝트로 얻으려는 것 한 줄" },
  { key: "관련", type: "links", hint: "관련 프로젝트·노트" },
];

/** A row of a project's properties panel: the template's fields first, then the note's other keys. */
export type PropertyRow = {
  key: string;
  type: PropertyType;
  /** As written (null: the key with no value); empty when the note does not have the key yet. */
  values: string[] | null;
  /** The note has the key. */
  present: boolean;
  fromTemplate: boolean;
  hint?: string;
};

/** A write to the note, kept a while so "되돌리기" can put the bytes back. */
export type ProjectWrite = { token: string; created: boolean; summary: string; page: ProjectPage };

export type ProjectEntryRequest = {
  section: "decision" | "question";
  text: string;
  /** Where it came from, linked from the line (`workbench://session/<id>#<item>`). */
  sessionId?: string | null;
  itemId?: string | null;
};

/** What the next request of a session will be told changed since its last one (알릴 변경). */
export type ChangeLine = { id: string; text: string };

/** A project in lists (home "프로젝트": cards, table, kanban): what its note says, read only when it changed. */
export type ProjectSummary = {
  workId: string;
  /** Explicit cover/thumbnail property, else the first image in the project note. */
  thumb?: PkmCard["thumb"];
  thumbUpdatedAt?: number;
  stage: string | null;
  tags: string[];
  related: string[];
  decisions: number;
  /** Open questions not ticked yet. */
  questions: number;
  noteExists: boolean;
  /** Every property of the note as written (the machine key left out), each with its kind; none without a note. */
  properties: { key: string; type: PropertyType; values: string[] }[];
  /** When the note file last changed (ms since 1970); null without a note. */
  noteUpdatedAt: number | null;
  /** The first line of the note's own words (not a heading), for lists; null when it has none. */
  preview: string | null;
};
