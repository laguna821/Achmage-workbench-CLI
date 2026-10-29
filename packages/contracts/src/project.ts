import type { Provider } from "./index.ts";

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
  stage: string | null;
  tags: string[];
  related: string[];
  decisions: number;
  /** Open questions not ticked yet. */
  questions: number;
  noteExists: boolean;
};
