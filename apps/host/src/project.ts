import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_STAGES,
  LINK_REASON_LABEL,
  PARTIAL_PROPOSAL,
  PROVIDER_LABEL,
  STAGE_KEY,
  TURN_BREAK_LABEL,
  isUnseen,
  turnBreakOf,
  turnEndText,
  type Artifact,
  type ArtifactRevision,
  type ChangeLine,
  type ProjectEntryRequest,
  type ProjectEvent,
  type ProjectFacts,
  type ProjectNote,
  type ProjectPage,
  type ProjectStage,
  type ProjectSummary,
  type ProjectWrite,
  type Provider,
  type Session,
  type StoppedPlace,
  type Work,
} from "@workbench/contracts";
import { PROJECT_NOTE_IN_GIT, WORKBENCH_DIR } from "./artifacts.ts";
import type { EventBus } from "./bus.ts";
import { HttpError } from "./errors.ts";
import type { Pkm } from "./pkm.ts";
import { ID_KEY, appendEntry, newNote, noteFileName, readNote, setBody, setEntryDone, setFrontmatterKey, type ReadNote } from "./project-note.ts";
import type { IndexEntry, WorkExtras } from "./search-index.ts";
import type { SessionManager } from "./sessions.ts";
import type { Store } from "./store.ts";

// "프로젝트 = 노트 한 장" (docs/design/프로젝트-노트-설계.md). A work's note is a real Markdown file in
// its folder — `‹이름›.md`, or `.workbench/project.md` in a git repository so the repository gains no
// visible file — made the first time a person writes something. What its sessions did is counted
// when shown (AI 0) and never written into the file. Every write can be undone while the file is
// still as that write left it.

const NOTES_KEY = "project.notes";
const STAGES_KEY = "project.stages";
const TOLD_KEY = "project.told";
const ENTRIES_KEY = "project.entries";
const WEEK = 7 * 24 * 3600 * 1000;
/** How much the change block before a request may take. */
const CHANGE_LIMIT = 1000;

type Told = { at: number; noteRevision: number };
/** What the person wrote to the note that the record shows as such: decisions, questions, stage changes. */
type EntryLog = { workId: string; at: number; section: "decision" | "question" | "stage"; text: string; sessionId: string | null; itemId: string | null };
type Write = { workId: string; path: string; before: Buffer | null; after: Buffer; at: number; unarchive: boolean; rearchive: boolean };

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const firstLine = (text: string, limit = 120) => {
  const line = text.split("\n").find((entry) => entry.trim())?.trim() ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/** A decision or question line as said to an engine: without its date and source link. */
export const entryGist = (text: string) =>
  text
    .replace(/\s+—\s+[^—]*\(\[원문\]\([^)]*\)\)\s*$/, "")
    .replace(/^\d{4}-\d{2}-\d{2}\s+/, "")
    .trim();

const SOURCE_LINK = /\(\[원문\]\(workbench:\/\/session\/([^#)\s]+)(?:#([^)\s]+))?\)\)/;

/**
 * A note's decisions and open questions as search entries: the line without its date and source
 * link is the title; the date (else the note's time) is when; a line from a conversation opens it
 * at that answer. Keyed by the line's words, so lines moving around keep their entries.
 */
export function noteEntries(workId: string, path: string, read: ReadNote, at: number): IndexEntry[] {
  const out: IndexEntry[] = [];
  const add = (kind: "decision" | "question", entry: ReadNote["decisions"][number]) => {
    const title = entryGist(entry.text);
    if (!title) return;
    const source = SOURCE_LINK.exec(entry.text);
    const day = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(entry.text);
    out.push({
      key: `decision:${workId}:${kind === "decision" ? "d" : "q"}:${createHash("sha256").update(entry.text).digest("hex").slice(0, 16)}`,
      kind,
      scope: "decision",
      workId,
      sessionId: source?.[1] ?? null,
      itemId: source?.[2] ?? null,
      path,
      at: day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : at,
      title,
      body: "",
      extra: kind === "question" ? { done: entry.done } : {},
    });
  };
  for (const entry of read.decisions) add("decision", entry);
  for (const entry of read.questions) add("question", entry);
  return out;
}

/** What an agreeing reply agreed on: the line with the mark, else the last line before it (plain, ≤ 80). */
export function agreedWords(reply: string) {
  const lines = reply.split("\n");
  const at = lines.findIndex((line) => line.includes("[[합의]]"));
  if (at === -1) return "";
  const plain = (line: string) => line.replace(/\[\[합의\]\]/g, "").replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").replace(/[*_`#>]/g, "").trim();
  for (let index = at; index >= 0; index -= 1) {
    const words = plain(lines[index]!);
    if (words) return words.length > 80 ? `${words.slice(0, 79)}…` : words;
  }
  return "";
}

/** Is this folder inside a git repository? (Walks up to the root looking for `.git`.) */
export function inGitRepository(folder: string): boolean {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return true;
    if (dirname(at) === at) return false;
  }
}

/** Lines added and removed between two texts, counted as multisets of lines (no AI, rough on purpose). */
export function lineCounts(before: string, after: string) {
  const count = (text: string) => {
    const map = new Map<string, number>();
    for (const line of text.split("\n")) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before);
  const b = count(after);
  let added = 0;
  let removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { added, removed };
}

export class Projects {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly manager: SessionManager;
  private readonly pkm: Pkm;
  private readonly writes = new Map<string, Write>();
  private readonly branches = new Map<string, { at: number; branch: string | null }>();
  /** Notes as last read, by path: read again only when the file's time or size changed. */
  private readonly summaryCache = new Map<string, { key: string; read: ReadNote; at: number }>();
  /** Works this module is archiving or restoring itself: the archive listener leaves those alone. */
  private readonly quiet = new Set<string>();

  constructor(store: Store, bus: EventBus, manager: SessionManager, pkm: Pkm) {
    this.store = store;
    this.bus = bus;
    this.manager = manager;
    this.pkm = pkm;
    manager.changeHook = (session, work, omit) => this.changeBlock(session, work, omit);
    manager.toldHook = (session) => this.markTold(session);
    pkm.projectCard = (work) => this.cardInfo(work);
    pkm.projectStage = (work) => this.stageOf(work, this.note(work));
    pkm.projectRule = (workId, fill) => this.ruleFill(workId, fill);
    // "찾는 길": decisions and open questions are found by search, and a work by its note's aliases,
    // properties and words. A note written here, by an engine, or (noticed when lists read it)
    // outside is indexed again.
    store.workExtras = (workId) => this.workExtras(workId);
    bus.subscribe((event) => {
      if (event.type === "artifact.upserted" && event.artifact.role === "project-note") this.indexNote(event.artifact.workId);
    });
    this.store.search.transaction(() => {
      for (const workId of Object.keys(this.notePaths())) this.indexNote(workId);
    });
  }

  // ── stored small things ─────────────────────────────────────────────────────────────────

  private readJson<T>(key: string, fallback: T): T {
    try {
      const raw = this.store.getMeta(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private writeJson(key: string, value: unknown) {
    this.store.setMeta(key, JSON.stringify(value));
  }

  private publish(workId: string | null) {
    if (workId) this.indexNote(workId);
    this.bus.publish({ type: "project.changed", workId });
  }

  stages(): ProjectStage[] {
    const saved = this.readJson<ProjectStage[] | null>(STAGES_KEY, null);
    return saved?.length ? saved : DEFAULT_STAGES;
  }

  /** The stage names and colours (설정). Notes keep the names they were written with. */
  setStages(list: ProjectStage[]): ProjectStage[] {
    const clean: ProjectStage[] = [];
    for (const stage of list) {
      const name = String(stage.name ?? "").trim().slice(0, 30);
      const color = /^#[0-9a-f]{6}$/i.test(String(stage.color ?? "")) ? String(stage.color).toLowerCase() : "#8b8d98";
      if (!name || clean.some((entry) => entry.name === name)) continue;
      clean.push({ name, color, ...(stage.archive ? { archive: true } : {}) });
    }
    if (!clean.length) throw new HttpError(400, "no_stages", "단계가 하나는 있어야 합니다.");
    // One archive stage at most: the first one marked.
    let archive = false;
    for (const stage of clean) {
      if (stage.archive && archive) delete stage.archive;
      if (stage.archive) archive = true;
    }
    this.writeJson(STAGES_KEY, clean);
    this.publish(null);
    return clean;
  }

  // ── where the note is ───────────────────────────────────────────────────────────────────

  private work(workId: string): Work {
    const work = this.manager.view.works.get(workId);
    if (!work) throw new HttpError(404, "work_not_found", "그 프로젝트가 없습니다.");
    return work;
  }

  private notePaths() {
    return this.readJson<Record<string, string>>(NOTES_KEY, {});
  }

  /** The note's path: where it was made (even if the work was renamed since), else where it would go. */
  notePath(work: Work): string {
    const known = this.notePaths()[work.id];
    if (known && existsSync(known)) return known;
    const found = this.findNote(work);
    if (found) {
      this.writeJson(NOTES_KEY, { ...this.notePaths(), [work.id]: found });
      return found;
    }
    return this.newPath(work);
  }

  /** A note of this work the user moved or renamed: found by its `workbench_id` among the folder's notes. */
  private findNote(work: Work): string | null {
    const candidates = [join(work.cwd, WORKBENCH_DIR, PROJECT_NOTE_IN_GIT)];
    try {
      for (const name of readdirSync(work.cwd).slice(0, 400)) if (name.toLowerCase().endsWith(".md")) candidates.push(join(work.cwd, name));
    } catch {
      return null;
    }
    for (const path of candidates) {
      try {
        if (!statSync(path).isFile()) continue;
        if (readNote(readFileSync(path, "utf8").slice(0, 4096)).id === work.id) return path;
      } catch {
        // Not readable now: not this one.
      }
    }
    return null;
  }

  private newPath(work: Work): string {
    if (inGitRepository(work.cwd)) return join(work.cwd, WORKBENCH_DIR, PROJECT_NOTE_IN_GIT);
    const base = noteFileName(work.title);
    const taken = (path: string) => existsSync(path);
    let path = join(work.cwd, base);
    for (let index = 1; taken(path); index += 1) path = join(work.cwd, base.replace(/\.md$/, ` (프로젝트${index > 1 ? ` ${index}` : ""}).md`));
    return path;
  }

  private noteArtifact(work: Work, path: string): Artifact | null {
    return this.manager.documents.list().find((artifact) => artifact.workId === work.id && artifact.path === path) ?? null;
  }

  // ── reading ─────────────────────────────────────────────────────────────────────────────

  note(work: Work): ProjectNote {
    const path = this.notePath(work);
    const artifact = this.noteArtifact(work, path);
    const revisions = artifact ? this.manager.documents.revisions(artifact.id) : [];
    const last = revisions.at(-1) ?? null;
    const base = { path, revision: artifact?.revision ?? null, lastAuthor: last?.author ?? null, lastSessionId: last?.sessionId ?? null, artifactId: artifact?.id ?? null };
    if (!existsSync(path)) return { ...base, exists: false, properties: [], stage: null, tags: work.tags ?? [], decisions: [], questions: [], body: "", problem: null };
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      return { ...base, exists: true, properties: [], stage: null, tags: [], decisions: [], questions: [], body: "", problem: `노트를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
    }
    const read = readNote(text);
    return { ...base, exists: true, properties: read.properties, stage: read.stage, tags: read.tags, decisions: read.decisions, questions: read.questions, body: read.body, problem: read.problem };
  }

  /** The stage shown: the archive stage for an archived work, else what the note says. */
  stageOf(work: Work, note: ProjectNote): string | null {
    if (work.archivedAt) return this.stages().find((stage) => stage.archive)?.name ?? note.stage;
    return note.stage;
  }

  page(workId: string): ProjectPage {
    const work = this.work(workId);
    const note = this.note(work);
    const sessionIds = new Set([...this.manager.view.sessions.values()].filter((session) => session.workId === workId).map((session) => session.id));
    return {
      workId,
      note: { ...note, stage: this.stageOf(work, note) },
      facts: this.facts(work),
      events: this.events(work, Date.now() - WEEK, 60),
      card: this.pkm.cardFor(work),
      stages: this.stages(),
      readNotes: this.pkm.notesReadBy(sessionIds),
    };
  }

  /** Everything recorded in the project, newest first (기록 칸 "전체"). */
  allEvents(workId: string) {
    return this.events(this.work(workId), 0, 300);
  }

  /** Every project as lists show it (archived ones too: the archive stage's column). */
  summaries(): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    for (const work of this.manager.view.works.values()) {
      const path = this.notePaths()[work.id] ?? null;
      const known = path ? this.readCached(path) : null;
      const read = known?.read ?? null;
      // Changed since it was last read (outside the app too): its search entries follow.
      if (known?.fresh) this.indexNote(work.id);
      const archiveStage = this.stages().find((stage) => stage.archive)?.name ?? null;
      out.push({
        workId: work.id,
        stage: work.archivedAt ? (archiveStage ?? read?.stage ?? null) : (read?.stage ?? null),
        tags: read?.tags ?? work.tags ?? [],
        related: read?.properties.find(([key]) => key === "관련")?.[1] ?? [],
        decisions: read?.decisions.length ?? 0,
        questions: read?.questions.filter((entry) => !entry.done).length ?? 0,
        noteExists: Boolean(read),
      });
    }
    return out;
  }

  /** A note as last read; read again (`fresh`) only when the file's time or size changed. Null: none. */
  private readCached(path: string): { read: ReadNote; at: number; fresh: boolean } | null {
    try {
      const stats = statSync(path);
      const key = `${stats.mtimeMs}:${stats.size}`;
      const cached = this.summaryCache.get(path);
      if (cached?.key === key) return { read: cached.read, at: cached.at, fresh: false };
      const read = readNote(readFileSync(path, "utf8"));
      this.summaryCache.set(path, { key, read, at: stats.mtimeMs });
      return { read, at: stats.mtimeMs, fresh: true };
    } catch {
      return null;
    }
  }

  // ── found by search ("찾는 길") ─────────────────────────────────────────────────────────

  /** What a work's own search entry gets from its note: aliases, properties (the stage among them), its own words. */
  private workExtras(workId: string): WorkExtras | null {
    const path = this.notePaths()[workId];
    const read = path ? this.readCached(path)?.read : null;
    if (!read) return null;
    const name = (key: string) => key.trim().replace(/:$/, "").toLowerCase();
    return {
      aliases: read.properties.filter(([key]) => name(key) === "aliases").flatMap(([, values]) => values ?? []),
      tags: read.tags,
      properties: read.properties.filter(([key]) => !/^(aliases|tags?)$/.test(name(key))),
      text: read.free,
    };
  }

  /**
   * A work's note in the search index: each decision and open question its own entry (scope "결정",
   * under its work, opening where it came from), and the work's entry again. Search is a
   * convenience: a failure here changes nothing else, and the next change of the note tries again.
   */
  private indexNote(workId: string) {
    try {
      const work = this.manager.view.works.get(workId);
      const path = work ? (this.notePaths()[workId] ?? null) : null;
      const known = path ? this.readCached(path) : null;
      const entries = work && path && known ? noteEntries(workId, path, known.read, known.at) : [];
      const prefix = `decision:${workId}:`;
      this.store.search.transaction(() => {
        const keep = new Set(entries.map((entry) => entry.key));
        for (const key of this.store.search.signatures(prefix).keys()) if (!keep.has(key)) this.store.search.remove(key);
        for (const entry of entries) this.store.search.put(entry);
        if (work) this.store.indexWork(workId);
      });
    } catch {
      // Not indexed now; found again after the note's next change.
    }
  }

  // ── counted, not written ────────────────────────────────────────────────────────────────

  /**
   * 멈춘 곳: what breaks left for the person, newest first. A session whose last turn broke off (its
   * engine died, the app restarted, the answer failed) or that reported an error, or that keeps
   * requests it did not send; a proposal a cut turn left; a link a break paused. A stop the
   * person made is not one, unless it kept requests or left a partial proposal.
   */
  private stopped(work: Work, sessions: Session[], fileIds: Set<string>): StoppedPlace[] {
    const out: StoppedPlace[] = [];
    const ends = this.store.lastTurnEnds(work.id);
    const name = (session: Session) => `${PROVIDER_LABEL[session.provider]} · ${session.purpose}`;
    for (const session of sessions) {
      // Going again (or asking for an approval): no longer stopped there.
      if (session.status === "starting" || session.status === "running" || session.status === "interrupting" || session.status === "awaitingApproval") continue;
      const end = ends.get(session.id);
      const broke = end ? turnBreakOf(end.status, end.cause) : null;
      const held = session.queued.filter((message) => message.held).length;
      const why = [
        end && broke && broke !== "stop" ? turnEndText(end) : session.status === "error" || session.lastError ? `오류${session.lastError ? `: ${firstLine(session.lastError, 60)}` : ""}` : null,
        held ? `보내지 않은 요청 ${held}개` : null,
      ].filter((part): part is string => Boolean(part));
      if (why.length) out.push({ kind: "session", text: `${name(session)} — ${why.join(" · ")}`, sessionId: session.id, at: end?.at ?? session.updatedAt });
    }
    const names = new Map(this.manager.documents.list().map((artifact) => [artifact.id, artifact.name] as const));
    for (const proposal of this.manager.documents.listProposals()) {
      if (proposal.status !== "pending" || !proposal.interruptedBy || !fileIds.has(proposal.artifactId)) continue;
      const text = `${names.get(proposal.artifactId) ?? "문서"} — ${PARTIAL_PROPOSAL} · ${TURN_BREAK_LABEL[proposal.interruptedBy]}`;
      out.push({ kind: "proposal", text, sessionId: proposal.sessionId, artifactId: proposal.artifactId, proposalId: proposal.id, at: proposal.updatedAt });
    }
    const all = this.manager.view.sessions;
    for (const link of this.manager.links.list()) {
      if (link.state !== "paused" || !link.reason || link.reason === "manual" || link.reason === "typed") continue;
      const mine = link.participants.filter((id) => sessions.some((session) => session.id === id));
      if (!mine.length) continue;
      const speaker = link.participants[link.turn];
      const text = `${link.participants.map((id) => all.get(id)?.purpose ?? "세션").join(" ⇄ ")} — ${LINK_REASON_LABEL[link.reason]}`;
      out.push({ kind: "link", text, sessionId: speaker && mine.includes(speaker) ? speaker : mine[0]!, at: link.updatedAt });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  private branch(cwd: string): string | null {
    const cached = this.branches.get(cwd);
    if (cached && Date.now() - cached.at < 30_000) return cached.branch;
    let branch: string | null = null;
    if (inGitRepository(cwd)) {
      try {
        branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
      } catch {
        branch = null;
      }
    }
    this.branches.set(cwd, { at: Date.now(), branch });
    return branch;
  }

  facts(work: Work): ProjectFacts {
    const sessions = [...this.manager.view.sessions.values()].filter((session) => session.workId === work.id && !session.archivedAt);
    const newest = (list: Session[]) => list.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
    const waiting = sessions.filter((session) => session.status === "awaitingApproval");
    const failed = sessions.filter((session) => session.status === "error" || Boolean(session.lastError));
    const artifacts = this.manager.documents.list().filter((artifact) => artifact.workId === work.id);
    const files = artifacts.filter((artifact) => artifact.role !== "project-note");
    const fileIds = new Set(files.map((artifact) => artifact.id));
    const pending = this.manager.documents
      .listProposals()
      .filter((proposal) => fileIds.has(proposal.artifactId) && proposal.status === "pending")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const engines: Partial<Record<Provider, number>> = {};
    for (const session of sessions) engines[session.provider] = (engines[session.provider] ?? 0) + 1;
    const counts = this.store.workCounts(work.id);
    const revisions = { user: 0, engine: 0, external: 0 };
    for (const artifact of files) for (const revision of this.manager.documents.revisions(artifact.id)) revisions[revision.author] += 1;
    const sessionIds = new Set(sessions.map((session) => session.id));
    return {
      sessions: sessions.length,
      running: sessions.filter((session) => session.status === "starting" || session.status === "running" || session.status === "interrupting").length,
      attention: waiting.length,
      errors: failed.length,
      stopped: this.stopped(work, sessions, fileIds),
      unread: sessions.filter(isUnseen).length,
      proposals: pending.length,
      attentionSessionId: newest(waiting),
      errorSessionId: newest(failed),
      proposalId: pending[0]?.id ?? null,
      proposalArtifactId: pending[0]?.artifactId ?? null,
      lastActivity: Math.max(work.updatedAt, ...sessions.map((session) => session.updatedAt), ...files.map((artifact) => artifact.updatedAt)) || null,
      createdAt: work.createdAt,
      engines,
      models: [...new Set(sessions.map((session) => session.engineModel ?? session.model).filter((model): model is string => Boolean(model)))],
      requests: counts.requests,
      turnMs: counts.turnMs,
      files: files.length,
      revisions,
      schedules: this.manager.schedules.all().filter((schedule) => sessionIds.has(schedule.sessionId)).length,
      worktrees: sessions.filter((session) => session.worktree).length,
      folder: work.cwd,
      branch: this.branch(work.cwd),
    };
  }

  /** Requests, plan decisions, revisions, applied or dropped proposals, decisions and questions written here. */
  private events(work: Work, since: number, limit: number): ProjectEvent[] {
    const sessions = this.manager.view.sessions;
    const providerOf = (sessionId: string | null | undefined) => (sessionId ? (sessions.get(sessionId)?.provider ?? null) : null);
    const names = new Map(this.manager.documents.list().filter((artifact) => artifact.workId === work.id).map((artifact) => [artifact.id, artifact] as const));
    const events: ProjectEvent[] = [];
    for (const { sessionId, item } of this.store.workItems(work.id, since, limit)) {
      if (item.kind === "user" && !item.peer && !item.link) {
        events.push({ id: `request:${item.id}`, at: item.at, kind: "request", text: firstLine(item.text), sessionId, artifactId: null, by: "user", itemId: item.id });
      } else if (item.kind === "approval" && item.plan && (item.decision === "accept" || item.decision === "decline")) {
        events.push({ id: `plan:${item.id}`, at: item.at, kind: "plan", text: item.decision === "decline" ? "계획을 고쳐 달라고 함" : "계획대로 진행", sessionId, artifactId: null, by: "user", itemId: item.id });
      } else if (item.kind === "notice") {
        events.push({ id: `worktree:${item.id}`, at: item.at, kind: "worktree", text: `격리 사본의 변경을 원래 폴더에 적용 · ${sessions.get(sessionId)?.purpose ?? "세션"}`, sessionId, artifactId: null, by: "user", itemId: item.id });
      }
    }
    const mine = new Set([...sessions.values()].filter((session) => session.workId === work.id).map((session) => session.id));
    const purpose = (sessionId: string) => sessions.get(sessionId)?.purpose || "세션";
    // Hand-overs between sessions: answered (or not) as the source session saw it.
    for (const handoff of this.manager.listHandoffs()) {
      if (!mine.has(handoff.sourceSessionId) && !mine.has(handoff.targetSessionId)) continue;
      const at = handoff.answeredAt ?? handoff.createdAt;
      if (at < since || handoff.status === "sent") continue;
      const outcome = handoff.status === "answered" ? "답 받음" : "답 받지 못함";
      const sessionId = mine.has(handoff.sourceSessionId) ? handoff.sourceSessionId : handoff.targetSessionId;
      events.push({ id: `handoff:${handoff.id}`, at, kind: "handoff", text: `${purpose(handoff.sourceSessionId)} → ${purpose(handoff.targetSessionId)}: ${firstLine(handoff.text, 60)} · ${outcome}`, sessionId, artifactId: null, by: providerOf(handoff.targetSessionId) });
    }
    // Linked sessions that ended: who, why, how many hand-overs.
    for (const link of this.manager.links.list()) {
      if (link.state !== "ended" || !link.endedAt || link.endedAt < since) continue;
      const here = link.participants.find((id) => mine.has(id));
      if (!here) continue;
      const reason = link.reason ? ` · ${LINK_REASON_LABEL[link.reason]}` : "";
      // Agreed: what was agreed, from the reply that said so (its words before the mark).
      let agreed = "";
      if (link.reason === "agreed") {
        try {
          const last = this.manager.links.turns(link.id).turns.filter((turn) => turn.reply.includes("[[합의]]")).at(-1);
          const words = last ? agreedWords(last.reply) : "";
          if (words) agreed = ` "${words}"`;
        } catch {
          // The link's turns cannot be read now: the line says only that it was agreed.
        }
      }
      events.push({ id: `link:${link.id}`, at: link.endedAt, kind: "link", text: `세션 잇기 끝 · ${link.participants.map(purpose).join(" ⇄ ")}${reason}${agreed} · ${link.hops}번 주고받음`, sessionId: here, artifactId: null, by: null });
    }
    for (const revision of this.store.workRevisions(work.id, since, limit)) {
      const artifact = names.get(revision.artifactId);
      // The person's own writes to the note show as what they wrote (stage, decisions), not as revisions.
      if (!artifact || (artifact.role === "project-note" && revision.author !== "engine")) continue;
      const by = revision.author === "engine" ? providerOf(revision.sessionId) : revision.author;
      const what = artifact.role === "project-note" ? "프로젝트 노트" : artifact.name;
      events.push({ id: `revision:${revision.artifactId}:${revision.revision}`, at: revision.at, kind: "revision", text: `${what} r${revision.revision}${revision.note ? ` · ${firstLine(revision.note, 60)}` : ""}`, sessionId: revision.sessionId, artifactId: revision.artifactId, by });
    }
    for (const proposal of this.manager.documents.listProposals()) {
      const artifact = names.get(proposal.artifactId);
      if (!artifact || proposal.updatedAt < since || (proposal.status !== "applied" && proposal.status !== "discarded")) continue;
      events.push({ id: `proposal:${proposal.id}`, at: proposal.updatedAt, kind: "proposal", text: `${artifact.name} 수정안 ${proposal.status === "applied" ? "적용" : "버림"}`, sessionId: proposal.sessionId, artifactId: artifact.id, proposalId: proposal.id, by: "user" });
    }
    for (const entry of this.readJson<EntryLog[]>(ENTRIES_KEY, [])) {
      if (entry.workId !== work.id || entry.at < since) continue;
      events.push({ id: `${entry.section}:${entry.at}`, at: entry.at, kind: entry.section, text: entry.text, sessionId: entry.sessionId, artifactId: null, by: "user", itemId: entry.itemId });
    }
    return events.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  // ── writing (one key or one line), with a way back ──────────────────────────────────────

  private write(workId: string, summary: string, change: (text: string) => string, side: { unarchive?: boolean; rearchive?: boolean } = {}): ProjectWrite {
    const work = this.work(workId);
    const path = this.notePath(work);
    const before = existsSync(path) ? readFileSync(path) : null;
    const text = before ? before.toString("utf8") : newNote(work.id);
    if (before && readNote(text).problem) throw new HttpError(409, "note_unreadable", "노트의 속성 부분이 망가져 있어 고치지 않았습니다. 노트를 직접 열어 고쳐 주세요.");
    const next = change(text);
    if (before && next === text) return { token: "", created: false, summary, page: this.page(workId) };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    this.writeJson(NOTES_KEY, { ...this.notePaths(), [work.id]: path });
    this.recordRevision(work, path, null);
    const token = randomUUID();
    this.writes.set(token, { workId, path, before, after: Buffer.from(next), at: Date.now(), unarchive: Boolean(side.unarchive), rearchive: Boolean(side.rearchive) });
    for (const [key, entry] of this.writes) if (Date.now() - entry.at > 3600_000 || this.writes.size > 100) this.writes.delete(key);
    this.publish(workId);
    return { token, created: !before, summary, page: this.page(workId) };
  }

  /** The note as a document: each write is a revision; the note stays out of document lists. */
  private recordRevision(work: Work, path: string, sessionId: string | null) {
    const tracked = this.manager.documents.track(work.id, work.cwd, path, sessionId ? "engine" : "user", sessionId, "프로젝트 노트");
    const artifact = tracked?.artifact ?? this.noteArtifact(work, path);
    if (artifact) this.manager.documents.setRole(artifact.id, "project-note");
  }

  setProperty(workId: string, key: string, values: string[] | null): ProjectWrite {
    const name = key.trim();
    if (!name || name === ID_KEY) throw new HttpError(400, "bad_key", "그 이름의 속성은 쓸 수 없습니다.");
    if (name === STAGE_KEY) return this.setStage(workId, values?.[0] ?? null);
    const clean = values === null ? null : values.map((value) => value.trim()).filter(Boolean);
    const result = this.write(workId, values === null ? `${name} 지움` : `${name}: ${clean!.join(", ") || "(빈 값)"}`, (text) => setFrontmatterKey(text, name, clean));
    if (name === "tags") this.manager.updateWork(workId, { tags: (clean ?? []).map((tag) => tag.replace(/^#/, "")) });
    return result;
  }

  /** Set the stage; the archive stage puts the work in the archive, leaving it takes it out. */
  /** `via`: what set it when not the person's menu (a rule), said in the record. */
  setStage(workId: string, name: string | null, via: string | null = null): ProjectWrite {
    const work = this.work(workId);
    const stages = this.stages();
    const target = name ? stages.find((stage) => stage.name === name) : null;
    if (name && !target) throw new HttpError(400, "unknown_stage", "설정에 없는 단계입니다.");
    const previous = this.stageOf(work, this.note(work));
    const archiving = Boolean(target?.archive) && !work.archivedAt;
    const leaving = !target?.archive && Boolean(work.archivedAt);
    this.quiet.add(workId);
    try {
      if (archiving) this.manager.updateWork(workId, { archived: true });
      if (leaving) this.manager.updateWork(workId, { archived: false });
    } finally {
      this.quiet.delete(workId);
    }
    try {
      const written = this.write(workId, `단계: ${previous ?? "값 없음"} → ${name ?? "값 없음"}`, (text) => setFrontmatterKey(text, STAGE_KEY, name ? [name] : null), { unarchive: archiving, rearchive: leaving });
      if (written.token) this.logEntry({ workId, section: "stage", text: `단계 ${previous ?? "값 없음"} → ${name ?? "값 없음"}${via ? ` (${via})` : ""}`, sessionId: null, itemId: null });
      return written.token ? { ...written, page: this.page(workId) } : written;
    } catch (error) {
      this.quiet.add(workId);
      try {
        if (archiving) this.manager.updateWork(workId, { archived: false });
        if (leaving) this.manager.updateWork(workId, { archived: true });
      } finally {
        this.quiet.delete(workId);
      }
      throw error;
    }
  }

  /**
   * What a placement rule fills (pkm-rules.ts): the stage while the project has none (not the
   * archive stage), and its tag into a note that exists, so the work's tags and its note's agree.
   * Never in the way of the rule's placing itself.
   */
  private ruleFill(workId: string, fill: { stage: string | null; tag: string | null; rule: string }) {
    try {
      const work = this.work(workId);
      if (fill.stage && !this.stageOf(work, this.note(work)) && this.stages().some((stage) => stage.name === fill.stage && !stage.archive)) {
        this.setStage(workId, fill.stage, `규칙 「${fill.rule}」`);
      }
      const note = this.note(work);
      if (fill.tag && note.exists && !note.problem && !note.tags.includes(fill.tag)) this.setProperty(workId, "tags", [...note.tags, fill.tag]);
    } catch {
      // The rule placed the work; its note is left as it was.
    }
  }

  addEntry(workId: string, request: ProjectEntryRequest): ProjectWrite {
    const text = String(request.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (!text) throw new HttpError(400, "empty_entry", "남길 글이 없습니다.");
    const section = request.section === "question" ? "question" : "decision";
    const session = request.sessionId ? this.manager.view.sessions.get(request.sessionId) : null;
    const today = new Date();
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const source = session ? ` — ${session.provider === "claude" ? "Claude" : "Codex"} · ${session.purpose || "세션"} ([원문](workbench://session/${session.id}${request.itemId ? `#${request.itemId}` : ""}))` : "";
    const line = `${stamp} ${text}${source}`;
    const result = this.write(workId, section === "decision" ? `결정: ${text}` : `열린 질문: ${text}`, (current) => appendEntry(current, section, line));
    this.logEntry({ workId, section, text, sessionId: session?.id ?? null, itemId: request.itemId ?? null });
    return { ...result, page: this.page(workId) };
  }

  private logEntry(entry: Omit<EntryLog, "at">) {
    const log = this.readJson<EntryLog[]>(ENTRIES_KEY, []);
    log.push({ ...entry, at: Date.now() });
    this.writeJson(ENTRIES_KEY, log.slice(-2000));
  }

  setQuestionDone(workId: string, line: number, done: boolean): ProjectWrite {
    return this.write(workId, done ? "열린 질문 닫음" : "열린 질문 다시 엶", (text) => setEntryDone(text, line, done));
  }

  /** The body as edited in the app; refused when the note changed since the editor read it. */
  setBodyText(workId: string, body: string, baseRevision: number | null): ProjectWrite {
    const work = this.work(workId);
    const current = this.note(work);
    if ((current.revision ?? null) !== (baseRevision ?? null)) throw new HttpError(409, "note_changed", "그 사이 노트가 바뀌었습니다. 다시 열어 고쳐 주세요.");
    return this.write(workId, "노트 본문 고침", (text) => setBody(text, body));
  }

  /** Put the note back as it was before a write, if nothing changed it since. */
  undo(workId: string, token: string): ProjectPage {
    const entry = this.writes.get(token);
    if (!entry || entry.workId !== workId) throw new HttpError(404, "write_not_found", "되돌릴 수 있는 기록이 없습니다.");
    const current = existsSync(entry.path) ? readFileSync(entry.path) : null;
    if (!current || !current.equals(entry.after)) throw new HttpError(409, "note_changed", "그 뒤에 노트가 바뀌어 되돌리지 않았습니다.");
    const work = this.work(workId);
    if (entry.before === null) {
      unlinkSync(entry.path);
      const paths = this.notePaths();
      delete paths[workId];
      this.writeJson(NOTES_KEY, paths);
      const artifact = this.noteArtifact(work, entry.path);
      if (artifact) this.manager.documents.check(artifact.id);
    } else {
      writeFileSync(entry.path, entry.before);
      this.recordRevision(work, entry.path, null);
    }
    this.quiet.add(workId);
    try {
      if (entry.unarchive) this.manager.updateWork(workId, { archived: false });
      if (entry.rearchive) this.manager.updateWork(workId, { archived: true });
    } finally {
      this.quiet.delete(workId);
    }
    this.writes.delete(token);
    this.publish(workId);
    return this.page(workId);
  }

  /** An engine changed the note: put back the revision before its change (as a person's write). */
  revertEngineEdit(workId: string): ProjectWrite {
    const work = this.work(workId);
    const note = this.note(work);
    if (!note.artifactId || note.lastAuthor !== "engine" || !note.revision || note.revision < 2) throw new HttpError(409, "nothing_to_revert", "되돌릴 엔진의 변경이 없습니다.");
    const before = readFileSync(this.manager.documents.revisionPath(note.artifactId, note.revision - 1), "utf8");
    return this.write(workId, `엔진이 바꾼 노트를 r${note.revision - 1}로 되돌림`, () => before);
  }

  // ── what the engines are told ───────────────────────────────────────────────────────────

  /** The project part of a new session's context card. */
  cardInfo(work: Work) {
    const note = this.note(work);
    return {
      note: note.path,
      exists: note.exists,
      stage: this.stageOf(work, note),
      tags: note.tags,
      decisions: note.decisions.slice(-5).map((entry) => entryGist(entry.text)),
      questions: note.questions.filter((entry) => !entry.done).slice(-3).map((entry) => entryGist(entry.text)),
    };
  }

  private told() {
    return this.readJson<Record<string, Told>>(TOLD_KEY, {});
  }

  /** After a request went out: what this session knows is as of now. */
  markTold(session: Session) {
    const work = this.manager.view.works.get(session.workId);
    if (!work) return;
    const note = this.note(work);
    this.writeJson(TOLD_KEY, { ...this.told(), [session.id]: { at: Date.now(), noteRevision: note.revision ?? 0 } });
  }

  private who(revision: ArtifactRevision, sessionId: string) {
    if (revision.author === "user") return "사람이";
    if (revision.author === "external") return "앱 밖에서";
    if (revision.sessionId === sessionId) return "이 세션이";
    const other = revision.sessionId ? this.manager.view.sessions.get(revision.sessionId) : null;
    return other ? `다른 세션(${other.provider === "claude" ? "Claude" : "Codex"} · ${firstLine(other.purpose || "세션", 30)})이` : "다른 세션이";
  }

  private revisionText(artifactId: string, revision: number) {
    try {
      return readFileSync(this.manager.documents.revisionPath(artifactId, revision), "utf8");
    } catch {
      return null;
    }
  }

  /** What changed for this session since its last request (AI 0): documents, its proposals, the note. */
  changes(sessionId: string): ChangeLine[] {
    const session = this.manager.view.sessions.get(sessionId);
    const work = session ? this.manager.view.works.get(session.workId) : undefined;
    const told = this.told()[sessionId];
    if (!session || !work || !told) return [];
    const lines: ChangeLine[] = [];
    const textual = new Set(["markdown", "text", "html"]);
    for (const artifact of this.manager.documents.list()) {
      if (artifact.workId !== work.id || artifact.role === "project-note") continue;
      const revisions = this.manager.documents.revisions(artifact.id);
      const later = revisions.filter((revision) => revision.at > told.at && !(revision.author === "engine" && revision.sessionId === sessionId));
      if (!later.length) continue;
      const first = later[0]!;
      const last = later.at(-1)!;
      const from = first.baseRevision ?? first.revision - 1;
      let counts = "";
      if (textual.has(artifact.format) && from >= 1) {
        const before = this.revisionText(artifact.id, from);
        const after = this.revisionText(artifact.id, last.revision);
        if (before !== null && after !== null) {
          const { added, removed } = lineCounts(before, after);
          counts = ` (+${added} −${removed})`;
        }
      }
      lines.push({ id: `revision:${artifact.id}:${last.revision}`, text: `${artifact.name} r${from >= 1 ? from : 0}→r${last.revision}: ${this.who(last, sessionId)} 고침${counts}` });
    }
    for (const proposal of this.manager.documents.listProposals()) {
      if (proposal.sessionId !== sessionId || proposal.updatedAt <= told.at || (proposal.status !== "applied" && proposal.status !== "discarded")) continue;
      const name = this.manager.documents.list().find((artifact) => artifact.id === proposal.artifactId)?.name ?? "문서";
      lines.push({ id: `proposal:${proposal.id}`, text: `${name}: 이 세션의 수정안을 사람이 ${proposal.status === "applied" ? "적용함" : "버림"}` });
    }
    const note = this.note(work);
    if (note.artifactId && (note.revision ?? 0) > told.noteRevision) {
      const before = told.noteRevision >= 1 ? this.revisionText(note.artifactId, told.noteRevision) : null;
      const old = before === null ? null : readNote(before);
      const stageNow = this.stageOf(work, note);
      if ((old?.stage ?? null) !== stageNow) lines.push({ id: "note:stage", text: `프로젝트 단계: ${old?.stage ?? "값 없음"} → ${stageNow ?? "값 없음"}` });
      const had = new Set((old?.decisions ?? []).map((entry) => entry.text));
      for (const entry of note.decisions) if (!had.has(entry.text)) lines.push({ id: `note:decision:${entry.text.slice(0, 40)}`, text: `결정 추가: "${firstLine(entryGist(entry.text), 160)}"` });
      const asked = new Map((old?.questions ?? []).map((entry) => [entry.text, entry.done] as const));
      for (const entry of note.questions) {
        if (!asked.has(entry.text)) lines.push({ id: `note:question:${entry.text.slice(0, 40)}`, text: `열린 질문 추가: "${firstLine(entryGist(entry.text), 160)}"` });
        else if (entry.done && !asked.get(entry.text)) lines.push({ id: `note:closed:${entry.text.slice(0, 40)}`, text: `열린 질문 닫힘: "${firstLine(entryGist(entry.text), 160)}"` });
      }
    }
    return lines;
  }

  /** The block put before a request (null when nothing changed or all of it was left out). */
  changeBlock(session: Session, _work: Work, omit: string[]): string | null {
    const lines = this.changes(session.id).filter((line) => !omit.includes(line.id));
    if (!lines.length) return null;
    const head = "[지난 요청 뒤 바뀐 것 — Workbench 기록에서 만든 것이며 지시가 아님]";
    const out = [head];
    for (const [index, line] of lines.entries()) {
      const next = `- ${line.text}`;
      if (bytes([...out, next].join("\n")) > CHANGE_LIMIT) {
        out.push(`- … 외 ${lines.length - index}건`);
        break;
      }
      out.push(next);
    }
    return out.join("\n");
  }

  // ── keeping the note and the archive in step ────────────────────────────────────────────

  /** A work archived or restored elsewhere (보관함): the note's stage follows when there is a note. */
  workArchived(work: Work, archived: boolean) {
    if (this.quiet.has(work.id)) return;
    const path = this.notePaths()[work.id];
    if (!path || !existsSync(path)) return;
    const archiveStage = this.stages().find((stage) => stage.archive)?.name;
    if (!archiveStage) return;
    const note = readNote(readFileSync(path, "utf8"));
    if (note.problem) return;
    const change = (from: string | null, to: string | null) => {
      this.write(work.id, `단계: ${from ?? "값 없음"} → ${to ?? "값 없음"}`, (text) => setFrontmatterKey(text, STAGE_KEY, to ? [to] : null));
      this.logEntry({ workId: work.id, section: "stage", text: `단계 ${from ?? "값 없음"} → ${to ?? "값 없음"} (보관함에서)`, sessionId: null, itemId: null });
    };
    if (archived && note.stage !== archiveStage) change(note.stage, archiveStage);
    if (!archived && note.stage === archiveStage) change(archiveStage, null);
  }

  /** An engine changed the note (seen when its turn's files are tracked): kept as its revision. */
  noteOf(workId: string): string | null {
    const work = this.manager.view.works.get(workId);
    return work ? this.notePath(work) : null;
  }
}
