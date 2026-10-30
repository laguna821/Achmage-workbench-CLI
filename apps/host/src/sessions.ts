import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  PROTOCOL_VERSION,
  accessFor,
  applyItemEvent,
  isAccessMode,
  type AccessMode,
  type ApprovalDecision,
  type CreateSessionRequest,
  type CreateWorkRequest,
  type CreateWorkspaceRequest,
  type UpdateWorkspaceRequest,
  type Workspace,
  type Folder,
  type Provider,
  type ProviderStatus,
  type Session,
  type Snapshot,
  type TranscriptItem,
  type UiPrefs,
  formatOf,
  DESIGN_EXTENSION,
  type DocRef,
  type DocumentTools,
  type CreateTarget,
  type ExportMarkdownRequest,
  type QueuedMessage,
  type ImportCandidate,
  type ForkResult,
  type ImportRequest,
  type Attachment,
  type SendResult,
  type ExportMarkdownResult,
  type SearchPage,
  type UpdateFolderRequest,
  type DeleteFolderResult,
  type UpdateWorkRequest,
  type Handoff,
  type HandoffRequest,
  type LinkHop,
  type Proposal,
  type Provenance,
  type RequestDraw,
  type UpdateSessionRequest,
  type Work,
  turnBreakOf,
} from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import { HttpError } from "./errors.ts";
import { folderColor, folderIcon, liftOut } from "./folders.ts";
import { Documents, isWorkbenchPath } from "./artifacts.ts";
import { Workspaces } from "./workspaces.ts";
import { physicalPath, withinDirectory } from "./directory-operations.ts";
import { WorktreeWorkspaces } from "./worktree-workspaces.ts";
import { Terminals } from "./terminals.ts";
import { WorkspacePreparation } from "./workspace-preparation.ts";
import { SourceControl } from "./source-control.ts";
import { ScmReviews, type ScmReviewHooks } from "./scm-review.ts";
import { GitHubFeedback } from "./github-feedback.ts";
import { GitHubReviews } from "./github.ts";
import { GitHubActions } from "./github-actions.ts";
import { WorkspaceLayouts } from "./layouts.ts";
import type { Kordoc } from "./kordoc.ts";
import type { AdapterSink, LoginStart, ProviderAdapter } from "./providers/types.ts";
import type { Store } from "./store.ts";
import { adaptTitle, titleFor } from "./titles.ts";
import { blankDesign, designProblem, type DesignPreset } from "./design.ts";
import { IeumOffice, ieumFromCliDir, installIeumOffice, type InstallProgress } from "./ieumoffice.ts";
import { findHop, openInHop, openWithDesktop } from "./hop.ts";
import { findPdfcraft } from "./pdfcraft.ts";
import { createGuide } from "./create.ts";
import { CreationJournal, type CreationRecord } from "./creation-journal.ts";
import { UserSkills } from "./user-skills.ts";
import { SkillLibrary } from "./skill-library.ts";
import { SendGate } from "./send-gate.ts";
import { OfficeSessions } from "./office-sessions.ts";
import { copyMcp, copySkill, integrations, type EngineBinaries } from "./integrations.ts";
import { exportFileName, sessionMarkdown } from "./export-md.ts";
import { Attachments } from "./attachments.ts";
import { imagesNamed, keepImage, withImages } from "./tool-images.ts";
import { ImageGen } from "./imagegen.ts";
import { SessionLinks } from "./links.ts";
import { Schedules } from "./schedules.ts";
import { applyWorktree, createWorktree, removeWorktree, worktreeChanges } from "./worktrees.ts";
import type { AgentBrowser } from "./browse.ts";
import { handoffError, heldNotice, provenanceOf, restartTurnEnd, stampTurnEnd } from "./recovery.ts";
import { Finder, type SearchOptions } from "./search.ts";
import { EngineInstaller } from "./engine-install.ts";
import { installToolWrappers } from "./tool-bin.ts";

export { HttpError };

const hashText = (text: string) => createHash("sha256").update(text).digest("hex");
function requestFingerprint(text: string, refs: DocRef[], create: CreateTarget | null, attachments: Attachment[], notes: string[]) {
  const extra = [attachments.length ? attachments.map((entry) => entry.id).join(",") : "", notes.length ? JSON.stringify(notes) : ""].filter(Boolean);
  return hashText(refs.length || create || extra.length ? `${text}\u0000${JSON.stringify(refs)}\u0000${JSON.stringify(create)}${extra.map((part) => `\u0000${part}`).join("")}` : text);
}

/** An order key from the UI: a finite number. */
function finiteSort(value: unknown) {
  const sort = Number(value);
  if (!Number.isFinite(sort)) throw new HttpError(400, "invalid_sort", "순서 값이 올바르지 않습니다.");
  return sort;
}

/** Write next to the target, then rename, so a reader never sees half a file. */
function writeAtomic(path: string, text: string) {
  const temporary = `${path}.workbench-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** True when `path` is not inside `folder`. */
function relativeOutside(folder: string, path: string) {
  const rel = relative(resolve(folder), resolve(path));
  return !rel || rel.startsWith("..") || isAbsolute(rel);
}

/** Whether a Markdown file is an export of this conversation (its front matter names the session). */
function exportedFrom(path: string, sessionId: string) {
  try {
    return readFileSync(path, "utf8").slice(0, 2000).includes(`\nsession: ${sessionId}\n`);
  } catch {
    return false;
  }
}

export type ManagerOptions = {
  hostId: string;
  hostLabel: string;
  /** Parent directory for works started without a folder. */
  managedWorksDir: string;
  /** The parent the user chose for new works started without a folder ("새 프로젝트 폴더 위치", entry.ts). */
  worksDir?: () => string;
  /** Gateway data folder (document revisions live under it). Defaults to the parent of managedWorksDir. */
  dataDir?: string;
  /** Hangul document engine; without it HWPX/HWP are listed but not opened as text. */
  kordoc?: Kordoc | null;
  /** Word/PowerPoint/Excel engine (the IeumOffice command line tool). */
  ieum?: IeumOffice | null;
  /** The agent browser (browse.ts): one visible window sessions may use. */
  browse?: AgentBrowser | null;
  /** Isolated profiles/tests may supply a skill home; native defaults use the person's home. */
  skillHomeDir?: string;
  ptyBinary?: string;
};

const DEFAULT_PURPOSE = /^대화 \d+$/;

/**
 * A request sent with more than its text: a drawing gives the engine its own instructions, marks
 * the request as "그림", and does not make the drawing session the one its work shows.
 */
/**
 * How a request goes: `attachments` pasted or dropped files; `plan` "계획 먼저"; `engineText` what the
 * engine gets instead of the built text; `draw` a picture request; `activate: false` keeps the
 * work's active session as it is (a drawing session working for another conversation).
 */
export type SendOptions = {
  attachments?: Attachment[];
  plan?: boolean;
  engineText?: string;
  draw?: RequestDraw;
  activate?: boolean;
  /** A message a linked-session relay hands over: marked on the request, `header` read by the engine only. */
  relay?: { hop: LinkHop; header: string } | null;
  /** Vault notes to read with the request (vault-relative paths; read-only copies, see pkm.ts). */
  notes?: string[];
  /** Sent by a schedule ("예약 작업"): marked on the request. */
  scheduled?: boolean;
  /** Lines of "지난 요청 뒤 바뀐 것" the user chose not to send (project.ts `changes`). */
  omitChanges?: string[];
};

type PendingCreate = CreationRecord;

const SKIPPED_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", ".cache"]);

/** Document files under a folder modified after `since` (shallow and bounded: work folders can be large). */
export function recentDocuments(root: string, since: number, maxDepth = 3, maxEntries = 4000): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > maxEntries) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) walk(path, depth + 1);
      } else if (entry.isFile() && formatOf(path) && !isWorkbenchPath(path)) {
        try {
          if (statSync(path).mtimeMs >= since) found.push(path);
        } catch {
          // Gone in the meantime.
        }
      }
    }
  };
  walk(root, 0);
  return found;
}

/** Plain start of a reply for overview cards. */
export function previewOf(text: string) {
  const flat = plain(text);
  return flat.length > 180 ? `${flat.slice(0, 180).trimEnd()}…` : flat;
}

/** A short stretch of a message around the first match, with every match marked. */
export function snippetOf(text: string, terms: string[], width = 120): { snippet: string; ranges: [number, number][] } {
  const flat = text.replace(/```[a-zA-Z0-9_-]*/g, " ").replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const needles = terms.map((term) => term.toLowerCase()).filter(Boolean);
  const first = Math.min(...needles.map((needle) => lower.indexOf(needle)).filter((index) => index >= 0), flat.length);
  let start = first >= flat.length ? 0 : Math.max(0, first - Math.floor(width / 3));
  if (start > 0) {
    const space = flat.lastIndexOf(" ", start);
    if (space > start - 12) start = space + 1;
  }
  let end = Math.min(flat.length, start + width);
  if (end < flat.length) {
    const space = flat.indexOf(" ", end);
    if (space !== -1 && space < end + 12) end = space;
  }
  const prefix = start > 0 ? "…" : "";
  const snippet = `${prefix}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  const ranges: [number, number][] = [];
  const lowerSnippet = snippet.toLowerCase();
  for (const needle of needles) {
    for (let at = lowerSnippet.indexOf(needle); at !== -1; at = lowerSnippet.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return { snippet, ranges };
}

function plain(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~|]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Vault notes a request reads (pkm.ts): the words for the engine and what the conversation shows. */
export type NoteHook = (notes: string[], cwd: string, sessionId: string) => { prompt: string; refs: { path: string; title: string }[] };

/** A request steered into a running turn, kept until the session's next own turn starts. */
type Steered = { requestId: string; text: string; refs: DocRef[]; attachments: Attachment[]; item: Extract<TranscriptItem, { kind: "user" }> | null; dropped: boolean };

export class SessionManager {
  private readonly folders = new Map<string, Folder>();
  private readonly works = new Map<string, Work>();
  private readonly sessions = new Map<string, Session>();
  private readonly transcripts = new Map<string, TranscriptItem[]>();
  private readonly dirtyItems = new Map<string, Set<string>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly adapters = new Map<Provider, ProviderAdapter>();
  private readonly handoffs = new Map<string, Handoff>();
  /** When each session's current turn began (for the after-turn folder scan). */
  private readonly turnStarted = new Map<string, number>();
  /** The request each session's current turn answers (what made the documents it writes). */
  private readonly turnRequest = new Map<string, string>();
  /** The new document each running request asked for. */
  private readonly creating = new Map<string, PendingCreate>();
  private readonly sendGate = new SendGate();
  readonly creations: CreationJournal;
  readonly userSkills: UserSkills;
  readonly skillLibrary: SkillLibrary;
  readonly documents: Documents;
  readonly office: OfficeSessions;
  readonly workspaces: Workspaces;
  readonly worktreeWorkspaces: WorktreeWorkspaces;
  readonly terminals: Terminals;
  readonly preparation: WorkspacePreparation;
  readonly sourceControl: SourceControl;
  readonly scmReviews: ScmReviews;
  readonly githubFeedback: GitHubFeedback;
  readonly github: GitHubReviews;
  readonly githubActions: GitHubActions;
  readonly layouts: WorkspaceLayouts;
  /** "그림": pictures drawn with GPT Image through Codex (imagegen.ts). */
  readonly images: ImageGen;
  /** Linked sessions ("세션 잇기"): replies relayed between sessions in turn (links.ts). */
  readonly links: SessionLinks;
  /** "예약 작업": requests sessions get at set times (schedules.ts). */
  readonly schedules: Schedules;
  /** "설치": engines installed with one click (engine-install.ts). */
  readonly engineSetup: EngineInstaller;
  /** Set by the PKM layer: vault notes attached to a request become read-only references. */
  noteHook: NoteHook | null = null;
  /** What changed for a session since its last request (project.ts), put before the request. */
  changeHook: ((session: Session, work: Work, omit: string[]) => string | null) | null = null;
  /** A request went out: the session now knows the project as of now (project.ts). */
  toldHook: ((session: Session) => void) | null = null;
  /** "찾는 길": the search over the store's index, for Ctrl+K, saved views and workbench-find (search.ts). */
  readonly finder: Finder;
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly options: ManagerOptions;

  constructor(store: Store, bus: EventBus, options: ManagerOptions) {
    this.store = store;
    this.bus = bus;
    this.options = options;
    this.creations = new CreationJournal(store, options.dataDir ?? dirname(options.managedWorksDir));
    this.userSkills = new UserSkills(store, { dataDir: options.dataDir ?? dirname(options.managedWorksDir), homeDir: options.skillHomeDir });
    this.skillLibrary = new SkillLibrary(this.userSkills, options.dataDir ?? dirname(options.managedWorksDir), options.skillHomeDir);
    this.workspaces = new Workspaces(store, options.hostId, bus);
    this.worktreeWorkspaces = new WorktreeWorkspaces(store, this.workspaces, options.dataDir ?? dirname(options.managedWorksDir), (id) => this.requireWork(id));
    this.terminals = new Terminals(store, this.workspaces, options.ptyBinary);
    this.preparation = new WorkspacePreparation(store, this.workspaces, this.terminals, options.dataDir ?? dirname(options.managedWorksDir), (id) => this.requireWork(id));
    this.sourceControl = new SourceControl(store, this.workspaces, {
      sharedLinks: (root) => this.preparation.sharedLinks(root),
      assertWorkingIdle: (root) => this.documents.registry.assertDirectoryIdle(root),
      assertIdle: (root) => {
        if (this.preparation.busy(root) || [...this.sessions.values()].some((session) => {
          if (session.status === "idle" || session.status === "error") return false;
          const cwd = session.workspaceId ? this.workspaces.get(session.workspaceId).cwd : this.works.get(session.workId)?.cwd;
          return cwd && withinDirectory(root, physicalPath(cwd));
        })) throw new HttpError(409, "scm_busy", "이 폴더의 에이전트나 환경 준비가 실행 중입니다. 끝나거나 멈춘 뒤 Git 작업을 진행하세요.");
      },
    }, options.dataDir ?? dirname(options.managedWorksDir));
    this.github = new GitHubReviews(this.sourceControl);
    this.githubActions = new GitHubActions(store, this.github, (workspaceId) => {
      const space = this.workspaces.get(workspaceId); this.workspaces.requireActive(workspaceId, space.workId);
      if (space.hostId !== options.hostId || this.hidden(space.workId)) throw new HttpError(409, "github_workspace", "활성 로컬 작업공간에서 GitHub 작업을 진행하세요.");
    });
    this.layouts = new WorkspaceLayouts(store, this.workspaces);
    const reviewHooks: ScmReviewHooks = {
      targets: (workspaceId) => {
        const space = this.workspaces.get(workspaceId);
        if (space.hostId !== options.hostId || space.archivedAt || space.removedAt || this.hidden(space.workId)) return [];
        return [...this.sessions.values()].filter((session) => session.workspaceId === workspaceId && session.hostId === options.hostId && !this.hidden(session.workId, session.id)).map(({ id, purpose, provider, status }) => ({ id, purpose, provider, status }));
      },
      send: (id, requestId, text) => this.send(id, requestId, text, [], null, null, "queue", { activate: false }),
      evidence: (id, requestId) => {
        const items = this.loadItems(id), failure = items.find((item) => item.id === `error:${requestId}` || item.id === `queue-failed:${requestId}`), sent = items.find((item) => item.id === `user:${requestId}`);
        return { receipt: store.findRequest(requestId)?.sessionId === id, queued: this.sessions.get(id)?.queued.find((q) => q.id === requestId)?.text ?? null, sent: sent?.kind === "user" ? sent.text : null, failure: failure?.kind === "notice" ? failure.text : null };
      },
    };
    this.scmReviews = new ScmReviews(store, this.workspaces, this.sourceControl.reviewSnapshots, reviewHooks);
    this.githubFeedback = new GitHubFeedback(store, this.github, this.githubActions.discussions, reviewHooks);
    this.documents = new Documents(store, bus, options.dataDir ?? dirname(options.managedWorksDir), options.kordoc ?? null, options.ieum ?? null, this.workspaces);
    this.office = new OfficeSessions(store, this.documents, {
      session: (id) => this.requireSession(id),
      active: (session) => {
        if (session.hostId !== options.hostId || this.hidden(session.workId, session.id)) throw new HttpError(409, "office_session_inactive", "활성 로컬 세션을 선택해 주세요.");
        if (session.workspaceId) this.workspaces.requireActive(session.workspaceId, session.workId);
      },
      items: (id) => this.loadItems(id),
      item: (id, item) => this.sink.upsertItem(id, item),
      update: (id, patch) => this.sink.updateSession(id, patch),
      lock: (id, key, identity, action) => this.sendGate.run(id, key, identity, action),
    });
    this.engineSetup = new EngineInstaller({
      dataDir: options.dataDir ?? dirname(options.managedWorksDir),
      onChange: (engine, state) => {
        const adapter = this.adapters.get(engine);
        if (!adapter) return;
        // A finished install: the engine is looked for again, then its login is read.
        if (state?.state === "done") void adapter.locate?.().then(() => this.bus.publish({ type: "provider.status", status: this.engineSetup.decorate(adapter.status()) }));
        this.bus.publish({ type: "provider.status", status: this.engineSetup.decorate(adapter.status()) });
      },
    });
    this.attachments = new Attachments(options.dataDir ?? dirname(options.managedWorksDir));
    this.finder = new Finder(store.search, {
      works: () => this.works,
      sessions: () => this.sessions,
      folders: () => this.folders,
      artifact: (id) => {
        try {
          return this.documents.get(id);
        } catch {
          return null;
        }
      },
      proposals: () => this.documents.listProposals(),
      items: (id) => this.loadItems(id),
      hidden: (workId, sessionId) => this.hidden(workId, sessionId ?? null),
    });
    this.images = new ImageGen(
      {
        session: (id) => this.sessions.get(id),
        work: (id, workspaceId) => {
          const work = this.works.get(id);
          if (!work || !workspaceId) return work;
          const workspace = this.workspaces.list().find((entry) => entry.id === workspaceId && entry.workId === id);
          return workspace ? { ...work, cwd: workspace.cwd } : undefined;
        },
        sessions: () => [...this.sessions.values()],
        createSession: (workId, request) => this.createSession(workId, request, false),
        send: (sessionId, requestId, text, from, options) => this.send(sessionId, requestId, text, [], from, null, "auto", { ...options, activate: false }),
        upsertItem: (sessionId, item) => this.sink.upsertItem(sessionId, item),
        markSeen: (sessionId) => this.updateSession(sessionId, { seen: true }),
        getMeta: (key) => store.getMeta(key),
        setMeta: (key, value) => store.setMeta(key, value),
      },
      options.dataDir ?? dirname(options.managedWorksDir),
    );
    for (const handoff of store.handoffs()) this.handoffs.set(handoff.id, handoff);
    // Rows written by older versions may lack newer fields.
    for (const folder of store.folders()) this.folders.set(folder.id, { ...folder, archivedAt: folder.archivedAt ?? null });
    for (const work of store.works()) {
      this.works.set(work.id, {
        ...work,
        titleSource: work.titleSource ?? "auto",
        pinned: work.pinned ?? false,
        // Works had no order of their own: the most recently active first, as they were listed.
        sort: work.sort ?? -work.updatedAt,
        archivedAt: work.archivedAt ?? null,
      });
    }
    for (const session of store.sessions()) this.sessions.set(session.id, {
        ...session,
        effort: session.effort ?? null,
        engineModel: session.engineModel ?? null,
        engineEffort: session.engineEffort ?? null,
        preview: session.preview ?? null,
        previewAt: session.previewAt ?? null,
        purposeSource: session.purposeSource ?? (DEFAULT_PURPOSE.test(session.purpose) ? "auto" : "user"),
        pinned: session.pinned ?? false,
        sort: session.sort ?? session.createdAt,
        archivedAt: session.archivedAt ?? null,
        // Replies from before the gateway kept "seen" count as seen.
        seenAt: session.seenAt === undefined ? (session.previewAt ?? null) : session.seenAt,
        unread: session.unread ?? false,
        queued: session.queued ?? [],
        access: session.access ?? null,
        context: session.context ?? null,
      });
    this.backfillOverview();
    this.recoverAfterRestart();
    this.recoverCreations();
    this.links = new SessionLinks(store, bus, {
      session: (id) => this.sessions.get(id),
      work: (id) => this.works.get(id),
      items: (id) => this.loadItems(id),
      send: (id, requestId, text, relay) => this.send(id, requestId, text, [], null, null, "auto", { relay }),
      interrupt: (id) => this.interrupt(id),
      note: (id, item) => this.sink.upsertItem(id, item),
      usage: (provider) => this.adapters.get(provider)?.status().usage ?? [],
      track: (workId, path, note) => {
        const work = this.works.get(workId);
        return work ? (this.documents.track(work.id, work.cwd, path, "user", null, note)?.artifact.id ?? this.artifactAt(work.id, path)) : null;
      },
    });
    this.images.recover();
    this.schedules = new Schedules({
      getMeta: (key) => store.getMeta(key),
      setMeta: (key, value) => store.setMeta(key, value),
      sessionExists: (id) => this.sessions.has(id),
      send: async (schedule, requestId) => {
        if (this.sessions.get(schedule.sessionId)?.archivedAt) throw new Error("archived");
        // Waits for a running turn ("끝나면 보내기"); the screen stays where the user is.
        await this.send(schedule.sessionId, requestId, schedule.text, [], null, null, "queue", { scheduled: true, activate: false });
      },
      changed: (schedules) => this.bus.publish({ type: "schedules.changed", schedules }),
    });
    options.browse?.bind({
      lookup: (sessionId) => {
        const session = this.sessions.get(sessionId);
        const project = session ? this.works.get(session.workId) : undefined;
        const work = session && project ? this.engineWork(session, project) : undefined;
        return session && work ? { session, work, access: this.accessOf(session) } : null;
      },
      sessions: () => [...this.sessions.values()],
      upsertItem: (sessionId, item) => this.sink.upsertItem(sessionId, item),
      updateSession: (sessionId, patch) => this.sink.updateSession(sessionId, patch),
      publish: (status) => this.bus.publish({ type: "browser.status", status }),
    });
  }

  /** Sessions from before auto titles and previews: derive both once from their stored transcript. */
  private backfillOverview() {
    for (const session of this.sessions.values()) {
      if (session.previewAt !== null && !DEFAULT_PURPOSE.test(session.purpose)) continue;
      const items = this.store.items(session.id);
      const requests = items.flatMap((item) => (item.kind === "user" ? [item.text] : []));
      const lastReply = items.findLast((item) => item.kind === "assistant" && item.text.trim());
      const patch: Partial<Session> = {};
      if (requests.length && session.purposeSource === "auto" && DEFAULT_PURPOSE.test(session.purpose)) {
        patch.purpose = titleFor(requests) ?? session.purpose;
      }
      if (lastReply && lastReply.kind === "assistant" && session.previewAt === null) {
        patch.preview = previewOf(lastReply.text);
        patch.previewAt = lastReply.at;
      }
      if (Object.keys(patch).length) this.saveSession({ ...session, ...patch });
    }
  }


  /** Adapters report through this sink; every change is persisted and published. */
  readonly sink: AdapterSink = {
    upsertItem: (sessionId, incoming) => {
      let item = incoming;
      if (item.kind === "turnEnd") {
        this.finishStreaming(sessionId);
        item = stampTurnEnd(item, this.sessions.get(sessionId), this.turnStarted.get(sessionId), this.turnRequest.get(sessionId));
      }
      const items = this.loadItems(sessionId);
      if (item.kind === "tool") item = this.withStepImages(sessionId, item, items);
      this.transcripts.set(sessionId, applyItemEvent(items, { type: "item.upserted", sessionId, item }));
      this.store.saveItem(sessionId, item);
      this.bus.publish({ type: "item.upserted", sessionId, item });
      if (item.kind === "assistant" && !item.streaming && item.text.trim()) {
        this.sink.updateSession(sessionId, { preview: previewOf(item.text), previewAt: Date.now() });
      }
      if (item.kind === "user" || item.kind === "turnEnd") this.retitle(sessionId);
      if (item.kind === "tool" && item.tool === "fileChange" && item.status === "completed" && item.paths?.length) {
        this.trackFiles(sessionId, item.id, item.paths);
      }
      if (item.kind === "turnEnd") this.afterTurn(sessionId, item);
    },
    toolImages: (sessionId, itemId, images) => {
      const kept = images.map((image) => keepImage(this.attachments, image)).filter((image) => image !== null);
      const item = this.loadItems(sessionId).find((entry) => entry.id === itemId);
      if (!kept.length || item?.kind !== "tool") return;
      this.sink.upsertItem(sessionId, { ...item, images: withImages(item.images, kept) });
    },
    delta: (sessionId, itemId, textDelta) => {
      const items = this.loadItems(sessionId);
      this.transcripts.set(sessionId, applyItemEvent(items, { type: "item.delta", sessionId, itemId, textDelta }));
      this.markDirty(sessionId, itemId);
      this.bus.publish({ type: "item.delta", sessionId, itemId, textDelta });
    },
    updateSession: (sessionId, patch) => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      const wasBusy = session.status !== "idle" && session.status !== "error";
      this.saveSession({ ...session, ...patch, updatedAt: Date.now() });
      if (wasBusy && patch.status === "idle") {
        // Ended in an error (an engine that died, also between turns): the waiting requests stay.
        if (patch.lastError) this.holdQueued(sessionId);
        this.drainSoon(sessionId);
      }
    },
    providerStatus: (status) => {
      this.bus.publish({ type: "provider.status", status: this.engineSetup.decorate(status) });
    },
    steerDropped: (sessionId, turnKeys, unsure = false) => {
      const lost: Steered[] = [];
      for (const key of turnKeys) {
        const entry = this.steering.get(sessionId)?.get(key);
        if (!entry) continue;
        // Reported while the steer request itself was still on its way: settled when it returns.
        if (!entry.item) entry.dropped = true;
        else lost.push(entry);
      }
      this.requeueDropped(sessionId, lost, unsure);
    },
    image: (sessionId, image) => this.images.onEngineImage(sessionId, image),
  };

  /** Sessions whose running turn only plans ("계획 먼저"), by the request that asked for it. */
  private readonly planning = new Map<string, string>();

  /** Pasted and dropped files, kept by content for requests. */
  readonly attachments: Attachments;

  /** Requests steered into a session's turns since its last own turn started (by request id). */
  private readonly steering = new Map<string, Map<string, Steered>>();

  /**
   * A stop dropped requests that were steered in but not yet taken: they are marked on the
   * conversation and wait again above the input, kept until the user sends or deletes them.
   */
  private requeueDropped(sessionId: string, lost: Steered[], unsure = false) {
    const session = this.sessions.get(sessionId);
    if (!session || !lost.length) return;
    for (const entry of lost) {
      this.steering.get(sessionId)?.delete(entry.requestId);
      // An engine that died cannot say what it took: those wait again without the mark.
      if (entry.item && !unsure) this.sink.upsertItem(sessionId, { ...entry.item, undelivered: true });
    }
    const again: QueuedMessage[] = lost.map((entry) => ({
      id: `again-${randomUUID()}`,
      text: entry.text,
      refs: entry.refs,
      create: null,
      at: Date.now(),
      held: true,
      ...(entry.attachments.length ? { attachments: entry.attachments } : {}),
    }));
    this.saveSession({ ...this.requireSession(sessionId), queued: [...again, ...this.requireSession(sessionId).queued] });
    this.sink.upsertItem(sessionId, {
      kind: "notice",
      id: `steer-dropped:${Date.now()}`,
      level: "info",
      text: unsure
        ? `엔진이 멈춰 작업 중에 보낸 요청 ${lost.length}개가 전해졌는지 알 수 없습니다. 입력창 위 목록에 다시 두었으니 보내거나 지울 수 있습니다.`
        : `멈췄기 때문에 작업 중에 보낸 요청 ${lost.length}개는 전해지지 않았습니다. 입력창 위 목록에서 다시 보내거나 지울 수 있습니다.`,
      at: Date.now(),
    });
  }

  registerAdapter(adapter: ProviderAdapter) {
    this.adapters.set(adapter.provider, adapter);
  }

  private adapter(provider: Provider) {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new HttpError(500, "provider_unavailable", `${provider} adapter is not registered`);
    return adapter;
  }

  /**
   * Engine processes do not survive an app restart. Anything that looked active is shown as
   * stopped instead of pretending it is still running; the next message resumes the session.
   */
  private recoverAfterRestart() {
    for (const session of this.sessions.values()) {
      if (session.status === "idle" || session.status === "error") continue;
      const items = this.loadItems(session.id);
      for (const item of items) {
        if (item.kind === "approval" && item.decision === null) {
          this.sink.upsertItem(session.id, { ...item, decision: "expired" });
        }
      }
      const end = restartTurnEnd(this.loadItems(session.id));
      this.sink.upsertItem(session.id, {
        kind: "notice",
        id: `restart:${Date.now()}`,
        level: "info",
        text: "앱이 다시 시작되어 진행 중이던 응답이 멈췄습니다. 이어서 요청하면 같은 세션에서 계속합니다.",
        at: Date.now(),
      });
      // The turn ends here, so what it left is settled as after a stop: the waiting requests stay,
      // a working copy it changed becomes a proposal, a request from another session gets its answer.
      if (end) {
        const owner = items.find((item) => item.kind === "user" && item.id === `user:${end.requestId}`)?.office;
        this.sink.upsertItem(session.id, { ...end, ...(owner ? { office: owner, model: null, effort: null } : {}) });
      }
      this.saveSession({ ...this.requireSession(session.id), status: "idle", activity: null, updatedAt: Date.now() });
    }
    // Left open by an older version (an engine that died without a turn end): settled the same way.
    for (const running of this.documents.runningProposals()) this.proposalReady(running.sessionId, this.documents.finishProposal(running.id, { interruptedBy: "restart" }));
    for (const handoff of this.handoffs.values()) {
      if (handoff.status === "sent") this.saveHandoff({ ...handoff, status: "failed", error: handoffError("restart"), answeredAt: Date.now() });
    }
    // Requests left waiting when the app closed are not sent on their own after a restart.
    for (const session of this.sessions.values()) this.holdQueued(session.id);
  }

  /** Keep every waiting request of a session until the user sends it; the number newly kept. */
  private holdQueued(sessionId: string) {
    const session = this.sessions.get(sessionId);
    const fresh = session?.queued.filter((entry) => !entry.held).length ?? 0;
    if (session && fresh) this.saveSession({ ...session, queued: session.queued.map((entry) => ({ ...entry, held: true })) });
    return fresh;
  }

  /** The turn ended normally: the oldest request not kept back becomes the next turn. */
  private drainSoon(sessionId: string) {
    setTimeout(() => {
      const session = this.sessions.get(sessionId);
      const next = session?.queued.find((entry) => !entry.held);
      if (!session || session.status !== "idle" || !next) return;
      this.saveSession({ ...session, queued: session.queued.filter((entry) => entry !== next) });
      void this.send(sessionId, next.id, next.text, next.refs, null, next.create, "auto", { attachments: next.attachments ?? [], plan: next.plan === true, notes: next.notes ?? [] }).catch((error: unknown) => {
        this.sink.upsertItem(sessionId, {
          kind: "notice",
          id: `queue-failed:${next.id}`,
          level: "error",
          text: `보낼 예정이던 요청을 보내지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
          at: Date.now(),
        });
      });
    }, 0);
  }

  /** Change the text of a waiting request. */
  updateQueued(sessionId: string, queuedId: string, text: string): Session {
    const session = this.requireSession(sessionId);
    const trimmed = text.trim();
    if (!trimmed) throw new HttpError(400, "empty_message", "보낼 내용이 없습니다.");
    if (!session.queued.some((entry) => entry.id === queuedId)) throw new HttpError(404, "queued_not_found", "보낼 예정인 요청이 없습니다.");
    const next = { ...session, queued: session.queued.map((entry) => (entry.id === queuedId ? { ...entry, text: trimmed } : entry)) };
    this.saveSession(next);
    return next;
  }

  /** Drop a waiting request (it was never sent). */
  cancelQueued(sessionId: string, queuedId: string): Session {
    const session = this.requireSession(sessionId);
    const next = { ...session, queued: session.queued.filter((entry) => entry.id !== queuedId) };
    this.saveSession(next);
    return next;
  }

  /** Send a waiting request now: into the running turn when the engine can take it, else as a new turn. */
  async sendQueued(sessionId: string, queuedId: string): Promise<SendResult> {
    const session = this.requireSession(sessionId);
    const entry = session.queued.find((item) => item.id === queuedId);
    if (!entry) throw new HttpError(404, "queued_not_found", "보낼 예정인 요청이 없습니다.");
    this.saveSession({ ...session, queued: session.queued.filter((item) => item.id !== queuedId) });
    return this.send(sessionId, entry.id, entry.text, entry.refs, null, entry.create, entry.plan ? "queue" : "steer", { attachments: entry.attachments ?? [], plan: entry.plan === true, notes: entry.notes ?? [] });
  }

  snapshot(): Snapshot {
    return {
      protocolVersion: PROTOCOL_VERSION,
      seq: this.bus.currentSeq,
      hostId: this.options.hostId,
      hostLabel: this.options.hostLabel,
      folders: [...this.folders.values()],
      works: [...this.works.values()],
      workspaces: this.workspaces.list(),
      sessions: [...this.sessions.values()],
      providers: [...this.adapters.values()].map((adapter) => this.engineSetup.decorate(adapter.status())),
      prefs: this.prefs(),
      artifacts: this.documents.list(),
      proposals: this.documents.listProposals(),
      handoffs: [...this.handoffs.values()],
      links: this.links.list(),
      tools: this.tools(),
      ...(this.options.browse ? { browser: this.options.browse.status() } : {}),
      schedules: this.schedules.all(),
    };
  }

  private ieumBusy: InstallProgress | null = null;
  private ieumVersion: string | null = null;

  /** Document engines on this computer, as the connection screen and onboarding show them. */
  tools(): DocumentTools {
    const kordoc = this.documents.kordoc;
    const ieum = this.documents.ieum;
    const hop = findHop();
    const busy = Boolean(this.ieumBusy && this.ieumBusy.stage !== "done" && this.ieumBusy.stage !== "error");
    return {
      kordoc: { available: Boolean(kordoc?.available), bundled: Boolean(kordoc?.bundled), version: kordoc?.version ?? null, path: kordoc?.runner ?? null, busy: false, message: null },
      ieumoffice: { available: Boolean(ieum?.available), bundled: Boolean(ieum?.bundled), version: this.ieumVersion, path: ieum?.cli ?? null, busy, message: this.ieumBusy?.message ?? null },
      hop: { available: Boolean(hop), bundled: Boolean(hop?.bundled), version: hop?.version ?? null, path: hop ? (hop.args?.at(-1) ?? hop.launcher) : null, busy: false, message: null },
      pdfcraft: (() => {
        const cli = findPdfcraft();
        return { available: Boolean(cli), bundled: Boolean(cli?.bundled), version: cli?.version ?? null, path: cli?.path ?? null, busy: false, message: null };
      })(),
    };
  }

  /** Ask each tool for its version once (cheap afterwards), then tell the screens. */
  async refreshTools() {
    this.ieumVersion = (await this.documents.ieum?.version()) ?? null;
    this.bus.publish({ type: "tools.status", tools: this.tools() });
    return this.tools();
  }

  /** Download, verify and unpack the latest IeumOffice for this user (never twice at once). */
  installIeumOffice() {
    if (this.ieumBusy && this.ieumBusy.stage !== "done" && this.ieumBusy.stage !== "error") return this.tools();
    const report = (step: InstallProgress) => {
      this.ieumBusy = step;
      this.bus.publish({ type: "tools.status", tools: this.tools() });
    };
    report({ stage: "download", message: "이음오피스 배포판을 확인하는 중…" });
    void installIeumOffice(report)
      .then(async (cli) => {
        const dataDir = this.options.dataDir ?? dirname(this.options.managedWorksDir);
        const ieum = new IeumOffice(ieumFromCliDir(dirname(cli)), { dataDir });
        if (installToolWrappers(dataDir, { kordoc: this.documents.kordoc?.runner ?? null, ieum: ieum.install, ieumAppWrapper: ieum.appWrapper }).includes("ieumoffice")) ieum.engineCommand = "ieumoffice";
        this.documents.ieum = ieum;
        await this.refreshTools();
      })
      .catch((error: unknown) => report({ stage: "error", message: error instanceof Error ? error.message : String(error) }));
    return this.tools();
  }

  private engineBinaries(): EngineBinaries {
    return { claude: this.adapters.get("claude")?.cli?.() ?? null, codex: this.adapters.get("codex")?.cli?.() ?? null };
  }

  /** The folder of the agent skill IeumOffice ships (skills/ieumoffice), when installed. */
  private ieumSkillDir() {
    const file = this.documents.ieum?.skillPath();
    return file ? dirname(file) : null;
  }

  /** MCP servers and skills as Claude Code and Codex see them (read only). */
  integrations() {
    return integrations(this.engineBinaries(), this.ieumSkillDir());
  }

  /** Give the other engine an MCP server one engine has (its official command, user scope). */
  async copyMcp(name: string, to: "claude" | "codex") {
    await copyMcp(this.engineBinaries(), name, to);
    return this.integrations();
  }

  /** Copy a skill folder from one engine's skills to the other's. */
  async copySkill(name: string, to: "claude" | "codex") {
    const view = await this.integrations();
    const skill = view.skills.find((entry) => entry.name === name);
    const from = to === "claude" ? skill?.codex : skill?.claude;
    if (!from) throw new HttpError(404, "skill_missing", "복사할 스킬을 찾지 못했습니다.");
    copySkill(name, from, to);
    return this.integrations();
  }

  /** Put IeumOffice's own agent skill (how to use the ieumoffice tool) into an engine's skills. */
  async installIeumSkill(to: "claude" | "codex") {
    const source = this.ieumSkillDir();
    if (!source) throw new HttpError(501, "ieumoffice_missing", "이음오피스의 사용법 스킬을 찾지 못했습니다.");
    copySkill("ieumoffice", source, to);
    return this.integrations();
  }

  /**
   * Open a document outside Workbench: Hangul files in HOP, everything else in the desktop's
   * default application. What the other app saves comes back as "changed on disk".
   */
  openExternal(artifactId: string) {
    const artifact = this.documents.check(artifactId);
    if (artifact.diskState === "missing") throw new HttpError(404, "file_missing", "파일이 없습니다.");
    const hop = artifact.format === "hwpx" || artifact.format === "hwp" ? findHop() : null;
    if (hop) openInHop(hop, artifact.path);
    else openWithDesktop(artifact.path);
    const app = hop ? "HOP" : "기본 앱";
    this.watchExternal(artifact.id, artifact.path, app);
    return { app };
  }

  private readonly external = new Map<string, () => void>();

  /**
   * A document the user opened in another app from here: what that app saves becomes the next
   * revision ("HOP에서 저장"), so the conversation and the AI see it without another step. Watched
   * for twelve hours; an AI proposal made on the older revision is then not applied automatically.
   */
  private watchExternal(artifactId: string, path: string, app: string) {
    this.external.get(artifactId)?.();
    let debounce: NodeJS.Timeout | undefined;
    const onChange = (current: Stats, previous: Stats) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      clearTimeout(debounce);
      // Editors write in steps (temporary file, rename); take the file once it has settled.
      debounce = setTimeout(() => {
        try {
          const before = this.documents.get(artifactId).revision;
          const after = this.documents.adoptDisk(artifactId, `${app}에서 저장`);
          if (after.revision !== before) this.bus.publish({ type: "artifact.upserted", artifact: after });
        } catch {
          // Gone or unreadable for a moment: the next change tries again.
        }
      }, 800);
    };
    watchFile(path, { interval: 1500 }, onChange);
    const stop = () => {
      unwatchFile(path, onChange);
      clearTimeout(debounce);
      clearTimeout(expiry);
      this.external.delete(artifactId);
    };
    const expiry = setTimeout(stop, 12 * 3600_000);
    expiry.unref();
    this.external.set(artifactId, stop);
  }

  prefs(): UiPrefs {
    try {
      return JSON.parse(this.store.getMeta("ui.prefs") ?? "{}") as UiPrefs;
    } catch {
      return {};
    }
  }

  setPrefs(prefs: unknown): UiPrefs {
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
      throw new HttpError(400, "invalid_prefs", "화면 설정 형식이 올바르지 않습니다.");
    }
    const json = JSON.stringify(prefs);
    if (json.length > 64_000) throw new HttpError(413, "prefs_too_large", "화면 설정이 너무 큽니다.");
    this.store.setMeta("ui.prefs", json);
    const saved = JSON.parse(json) as UiPrefs;
    this.bus.publish({ type: "prefs.updated", prefs: saved });
    return saved;
  }

  items(sessionId: string) {
    this.requireSession(sessionId);
    return { seq: this.bus.currentSeq, items: this.loadItems(sessionId) };
  }

  createFolder(name: string, parentId: string | null): Folder {
    const trimmed = name.trim();
    if (!trimmed) throw new HttpError(400, "invalid_name", "폴더 이름이 비어 있습니다.");
    if (parentId && !this.folders.has(parentId)) throw new HttpError(404, "folder_not_found", "상위 폴더가 없습니다.");
    const siblings = [...this.folders.values()].filter((folder) => folder.parentId === parentId);
    const sort = siblings.length ? Math.max(...siblings.map((folder) => folder.sort)) + 1 : 0;
    const folder: Folder = { id: randomUUID(), parentId, name: trimmed, sort, archivedAt: null };
    this.saveFolder(folder);
    return folder;
  }

  /** Rename, move (never inside itself), reorder, archive or restore a folder. Files never move. */
  updateFolder(folderId: string, patch: UpdateFolderRequest): Folder {
    const folder = this.folders.get(folderId);
    if (!folder) throw new HttpError(404, "folder_not_found", "폴더가 없습니다.");
    const next: Folder = { ...folder };
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new HttpError(400, "invalid_name", "폴더 이름이 비어 있습니다.");
      next.name = name.slice(0, 80);
    }
    if (patch.parentId !== undefined) {
      const parentId = patch.parentId ?? null;
      for (let at = parentId; at; at = this.folders.get(at)?.parentId ?? null) {
        if (!this.folders.has(at)) throw new HttpError(404, "folder_not_found", "옮길 폴더가 없습니다.");
        if (at === folderId) throw new HttpError(400, "folder_cycle", "폴더를 자기 안으로 옮길 수 없습니다.");
      }
      next.parentId = parentId;
    }
    if (patch.sort !== undefined) next.sort = finiteSort(patch.sort);
    if (patch.archived !== undefined) {
      if (patch.archived && this.busyUnder({ folderId })) throw new HttpError(409, "busy_inside", "이 폴더 안에서 진행 중인 세션이 있습니다. 끝나거나 멈춘 뒤에 보관하세요.");
      next.archivedAt = patch.archived ? Date.now() : null;
    }
    // The navigator's colour and icon (folders.ts checks what they may be).
    if (patch.color !== undefined) {
      const color = folderColor(patch.color);
      if (color === undefined) throw new HttpError(400, "invalid_color", "색은 #rrggbb로 적어 주세요.");
      next.color = color;
    }
    if (patch.icon !== undefined) {
      const icon = folderIcon(patch.icon);
      if (icon === undefined) throw new HttpError(400, "invalid_icon", "알 수 없는 아이콘입니다.");
      next.icon = icon;
    }
    this.saveFolder(next);
    return next;
  }

  /** "폴더만 지우기": the folder goes; its subfolders and projects move up to its parent (folders.ts). */
  deleteFolder(folderId: string): DeleteFolderResult {
    if (!this.folders.has(folderId)) throw new HttpError(404, "folder_not_found", "폴더가 없습니다.");
    const plan = liftOut([...this.folders.values()], [...this.works.values()], folderId);
    for (const child of plan.folders) this.saveFolder(child);
    for (const work of plan.works) this.saveWork(work);
    this.folders.delete(folderId);
    this.store.deleteFolder(folderId);
    this.bus.publish({ type: "folder.removed", folderId });
    return { parentId: plan.parentId, folders: plan.folders.map((folder) => folder.id), works: plan.works.map((work) => work.id) };
  }

  private saveFolder(folder: Folder) {
    this.folders.set(folder.id, folder);
    this.store.saveFolder(folder);
    this.bus.publish({ type: "folder.upserted", folder });
  }

  /** A session still working somewhere under a folder or in a work (archiving waits for it). */
  private busyUnder(scope: { folderId?: string; workId?: string }) {
    const inFolder = (folderId: string | null): boolean => {
      for (let at = folderId; at; at = this.folders.get(at)?.parentId ?? null) if (at === scope.folderId) return true;
      return false;
    };
    return [...this.sessions.values()].some((session) => {
      if (session.status === "idle" || session.status === "error") return false;
      if (scope.workId) return session.workId === scope.workId;
      return inFolder(this.works.get(session.workId)?.folderId ?? null);
    });
  }

  /** Hidden: archived itself, in an archived work, or under an archived folder. */
  private hidden(workId: string, sessionId: string | null = null) {
    if (sessionId && this.sessions.get(sessionId)?.archivedAt) return true;
    const work = this.works.get(workId);
    if (!work || work.archivedAt) return true;
    for (let at = work.folderId; at; at = this.folders.get(at)?.parentId ?? null) if (this.folders.get(at)?.archivedAt) return true;
    return false;
  }

  createWork(request: CreateWorkRequest): Work {
    const title = request.title.trim() || "새 작업";
    const folderId = request.folderId ?? null;
    if (folderId && !this.folders.has(folderId)) throw new HttpError(404, "folder_not_found", "폴더가 없습니다.");
    const id = randomUUID();
    let cwd = request.cwd?.trim() || null;
    const cwdManaged = !cwd;
    if (!cwd) {
      cwd = join(this.options.worksDir?.() ?? this.options.managedWorksDir, id);
      mkdirSync(cwd, { recursive: true });
    }
    const now = Date.now();
    // New works come first in their folder until the user orders them otherwise.
    const work: Work = {
      id,
      title,
      titleSource: request.titleSource ?? "auto",
      folderId,
      cwd,
      cwdManaged,
      activeSessionId: null,
      pinned: false,
      sort: -now,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    work.defaultWorkspaceId = this.workspaces.defaultFor(work).id;
    this.saveWork(work);
    return work;
  }

  createWorkspace(workId: string, request: CreateWorkspaceRequest) {
    return this.workspaces.create(this.requireWork(workId), request);
  }

  updateWorkspace(id: string, patch: UpdateWorkspaceRequest) {
    const workspace = this.workspaces.get(id);
    if (workspace.removedAt !== null) throw new HttpError(409, "workspace_removed", "폴더가 제거된 작업공간입니다. 기록은 그대로 보관합니다.");
    if (patch.archived) { this.assertWorkspaceIdle(workspace); this.preparation.assertArchiveReady(workspace); }
    return this.workspaces.update(workspace, {
      ...(typeof patch.label === "string" && patch.label.trim() ? { label: patch.label.trim().slice(0, 80) } : {}),
      ...(typeof patch.archived === "boolean" ? { archivedAt: patch.archived ? Date.now() : null } : {}),
    });
  }

  private assertWorkspaceIdle(workspace: Workspace) {
    if (this.sourceControl.busy(workspace.cwd)) throw new HttpError(409, "workspace_busy", "이 작업공간에서 Git 작업이 진행 중입니다. 결과를 확인한 뒤 진행하세요.");
    if (this.preparation.busy(workspace.cwd)) throw new HttpError(409, "workspace_busy", "이 작업공간의 환경 준비가 진행 중입니다. 완료하거나 취소한 뒤 진행하세요.");
    if (this.terminals.busy(workspace.cwd)) throw new HttpError(409, "workspace_busy", "이 작업공간에서 실행 중인 터미널이 있습니다. 터미널에서 실행을 종료한 뒤 진행하세요.");
    if (this.worktreeWorkspaces.busy(workspace.id)) throw new HttpError(409, "workspace_busy", "이 작업공간에서 워크트리를 생성 중입니다. 완료하거나 취소한 뒤 진행하세요.");
    if ([...this.sessions.values()].some((session) => session.workspaceId === workspace.id && session.status !== "idle" && session.status !== "error")) {
      throw new HttpError(409, "workspace_busy", "이 작업공간에서 실행 중인 세션이 있습니다. 모두 끝나거나 멈춘 뒤에 진행하세요.");
    }
  }

  /**
   * Rename, move, reorder, pin, archive or note the session last looked at. None of these is
   * activity: `updatedAt` (and so "최근" order) changes only when the work itself does something.
   */
  updateWork(workId: string, patch: UpdateWorkRequest): Work {
    const work = this.requireWork(workId);
    if (patch.activeSessionId && this.sessions.get(patch.activeSessionId)?.workId !== workId) {
      throw new HttpError(400, "invalid_session", "다른 작업의 세션입니다.");
    }
    if (patch.folderId && !this.folders.has(patch.folderId)) throw new HttpError(404, "folder_not_found", "폴더가 없습니다.");
    const next: Work = { ...work };
    if (patch.activeSessionId !== undefined) next.activeSessionId = patch.activeSessionId;
    if (patch.folderId !== undefined) next.folderId = patch.folderId ?? null;
    if (patch.sort !== undefined) next.sort = finiteSort(patch.sort);
    if (patch.pinned !== undefined) next.pinned = Boolean(patch.pinned);
    if (patch.tags !== undefined) next.tags = [...new Set(patch.tags.map((tag) => String(tag).trim().replace(/^#/, "")).filter(Boolean))].slice(0, 20);
    if (patch.archived !== undefined) {
      if (patch.archived && this.busyUnder({ workId })) throw new HttpError(409, "busy_inside", "이 작업에서 진행 중인 세션이 있습니다. 끝나거나 멈춘 뒤에 보관하세요.");
      next.archivedAt = patch.archived ? Date.now() : null;
    }
    if (patch.title !== undefined) {
      // A name typed by hand stays; clearing it hands the title back to the automatic one.
      const title = patch.title.trim();
      next.title = title ? title.slice(0, 80) : work.title;
      next.titleSource = title ? "user" : "auto";
    }
    this.saveWork(next);
    if (next.titleSource === "auto" && patch.title !== undefined) this.retitleWork(workId, true);
    return this.requireWork(workId);
  }

  /** `activate`: the new session becomes the one its work shows (not for a drawing session made on the side). */
  createSession(workId: string, request: CreateSessionRequest, activate = true): Session {
    const work = this.requireWork(workId);
    const workspace = this.workspaces.requireActive(request.workspaceId ?? this.workspaces.defaultFor(work).id, workId);
    if (request.provider !== "claude" && request.provider !== "codex") {
      throw new HttpError(400, "invalid_provider", "지원하지 않는 엔진입니다.");
    }
    const now = Date.now();
    const count = [...this.sessions.values()].filter((session) => session.workId === workId).length;
    const session: Session = {
      id: randomUUID(),
      workId,
      workspaceId: workspace.id,
      ...(workspace.worktree ? { worktree: workspace.worktree } : {}),
      provider: request.provider,
      hostId: this.options.hostId,
      nativeSessionId: null,
      purpose: request.purpose?.trim() || `대화 ${count + 1}`,
      purposeSource: request.purpose?.trim() ? "user" : "auto",
      model: request.model ?? null,
      effort: request.effort ?? null,
      engineModel: null,
      engineEffort: null,
      preview: null,
      previewAt: null,
      status: "idle",
      activity: null,
      lastError: null,
      pinned: false,
      sort: now,
      archivedAt: null,
      seenAt: null,
      unread: false,
      queued: [],
      access: isAccessMode(request.access) ? request.access : null,
      context: null,
      ...(request.browser === true ? { browser: true } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.saveSession(session);
    this.saveWork({ ...work, activeSessionId: activate ? session.id : work.activeSessionId, updatedAt: now });
    return session;
  }

  /** "격리 사본에서": a new session working in a git worktree of the work's repository. */
  async createIsolatedSession(workId: string, request: CreateSessionRequest): Promise<Session> {
    const work = this.requireWork(workId);
    if (request.provider !== "claude" && request.provider !== "codex") throw new HttpError(400, "invalid_provider", "지원하지 않는 엔진입니다.");
    // The copy first: a session is made only once it exists.
    const source = this.workspaces.requireActive(request.workspaceId ?? this.workspaces.defaultFor(work).id, workId);
    const worktree = await createWorktree(source.cwd, this.options.dataDir ?? dirname(this.options.managedWorksDir), randomUUID());
    const workspace = this.workspaces.fromWorktree(work, worktree);
    const session = this.createSession(workId, { ...request, workspaceId: workspace.id, worktree: false });
    this.saveSession({ ...this.requireSession(session.id), purpose: request.purpose?.trim() || `${session.purpose} · 격리 사본` });
    return this.requireSession(session.id);
  }

  /** "변경 검토": what an isolated session changed against where it started. */
  async worktreeChanges(sessionId: string) {
    const worktree = this.requireSession(sessionId).worktree;
    if (!worktree) throw new HttpError(409, "no_worktree", "격리 사본에서 일하는 세션이 아닙니다.");
    return worktreeChanges(worktree, this.preparation.sharedLinks(worktree.path));
  }

  /** Requests sent to other sessions ("다른 세션에 보내기"), as kept (the project record reads them). */
  listHandoffs(): Handoff[] {
    return [...this.handoffs.values()];
  }

  /** "원래 폴더에 적용": the changes go to the original checkout's files; the copy stays. */
  async applyWorktree(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (!session.worktree) throw new HttpError(409, "no_worktree", "격리 사본에서 일하는 세션이 아닙니다.");
    if (session.status !== "idle" && session.status !== "error") throw new HttpError(409, "session_busy", "응답이 끝난 뒤에 적용할 수 있습니다.");
    if (session.workspaceId) this.assertWorkspaceIdle(this.workspaces.get(session.workspaceId));
    await applyWorktree(session.worktree, this.preparation.sharedLinks(session.worktree.path));
    this.sink.upsertItem(sessionId, { kind: "notice", id: `worktree-applied:${Date.now()}`, level: "info", text: `격리 사본의 변경을 원래 폴더(${session.worktree.root})에 적용했습니다.`, at: Date.now() });
    return { ok: true };
  }

  /** "버리기": the copy and its branch go; the session is archived (its record stays readable). */
  async discardWorktree(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (!session.worktree) throw new HttpError(409, "no_worktree", "격리 사본에서 일하는 세션이 아닙니다.");
    if (session.status !== "idle" && session.status !== "error") throw new HttpError(409, "session_busy", "응답이 끝난 뒤에 버릴 수 있습니다.");
    const workspace = session.workspaceId ? this.workspaces.get(session.workspaceId) : null;
    if (workspace) this.assertWorkspaceIdle(workspace);
    if (workspace && !workspace.managed) throw new HttpError(409, "worktree_external", "연결한 외부 워크트리는 여기서 삭제하지 않습니다. 보관하면 폴더를 유지한 채 실행을 멈출 수 있습니다.");
    const root = physicalPath(session.worktree.path);
    const release = this.workspaces.directoryOperations.acquire(root);
    try {
      const affected = this.workspaces.list().filter((entry) => entry.hostId === this.options.hostId && withinDirectory(root, physicalPath(entry.cwd)));
      for (const entry of affected) { this.assertWorkspaceIdle(entry); this.preparation.assertArchiveReady(entry); }
      this.documents.registry.assertDirectoryIdle(root);
      const markRemoved = () => {
        const now = Date.now(), ids = new Set(affected.map((entry) => entry.id));
        for (const entry of affected) this.workspaces.update(entry, { archivedAt: now, removedAt: now });
        for (const entry of this.sessions.values()) {
          if (entry.id === sessionId || (entry.workspaceId && ids.has(entry.workspaceId))) this.saveSession({ ...entry, archivedAt: now });
        }
      };
      let branchRetained: boolean;
      try { ({ branchRetained } = await removeWorktree(session.worktree)); }
      catch (error) {
        // Git removed the checkout already. Keep the history readable, while reporting the
        // subsequent branch-cleanup error rather than pretending the whole action succeeded.
        if (error instanceof HttpError && error.code === "worktree_branch_cleanup_failed") {
          markRemoved();
          this.sink.upsertItem(sessionId, { kind: "notice", id: `worktree-removed:${Date.now()}`, level: "error", text: error.message, at: Date.now() });
        }
        throw error;
      }
      markRemoved();
      const retained = branchRetained ? ` 원래 폴더에 병합되지 않은 커밋이 있어 ${session.worktree.branch} 브랜치는 보존했습니다.` : "";
      this.sink.upsertItem(sessionId, { kind: "notice", id: `worktree-removed:${Date.now()}`, level: "info", text: `격리 사본을 버렸습니다. 연결된 작업공간과 세션은 기록을 보존해 보관함으로 옮겼습니다.${retained}`, at: Date.now() });
      return { ok: true };
    } finally { release(); }
  }

  /** Where the engine works for a session: its worktree, else the work folder. */
  private engineWork(session: Session, work: Work): Work {
    if (session.workspaceId) return { ...work, cwd: this.workspaces.get(session.workspaceId).cwd };
    return session.worktree ? { ...work, cwd: session.worktree.cwd } : work;
  }

  /** The access a session runs with (its own, else the one last picked for its engine, else the engine's). */
  accessOf(session: Session): AccessMode {
    return accessFor(session.provider, session.access, this.prefs(), this.adapters.get(session.provider)?.status().configuredAccess);
  }

  /**
   * Rename, or pick the model / effort used from the next turn on; pin, reorder, archive and the
   * read state change only how the session is listed (not its `updatedAt`).
   */
  updateSession(sessionId: string, patch: UpdateSessionRequest): Session {
    const session = this.requireSession(sessionId);
    const listing = patch.pinned !== undefined || patch.sort !== undefined || patch.archived !== undefined || patch.seen !== undefined || patch.muted !== undefined;
    const content = patch.purpose !== undefined || patch.model !== undefined || patch.effort !== undefined;
    const next = { ...session, updatedAt: content || !listing ? Date.now() : session.updatedAt };
    if (patch.pinned !== undefined) next.pinned = Boolean(patch.pinned);
    if (patch.muted !== undefined) next.muted = Boolean(patch.muted);
    if (patch.sort !== undefined) next.sort = finiteSort(patch.sort);
    if (patch.archived !== undefined) {
      if (patch.archived && session.status !== "idle" && session.status !== "error") {
        throw new HttpError(409, "session_busy", "응답 중인 세션은 보관할 수 없습니다. 멈춘 뒤에 보관하세요.");
      }
      next.archivedAt = patch.archived ? Date.now() : null;
    }
    if (patch.seen === true) {
      next.seenAt = Date.now();
      next.unread = false;
    } else if (patch.seen === false) {
      next.unread = true;
    }
    if (patch.purpose !== undefined) {
      // A name typed by hand stays; clearing it hands the name back to the automatic title.
      const trimmed = patch.purpose.trim();
      next.purpose = trimmed ? trimmed.slice(0, 60) : session.purpose;
      next.purposeSource = trimmed ? "user" : "auto";
    }
    if (patch.model !== undefined) next.model = patch.model || null;
    if (patch.effort !== undefined) next.effort = patch.effort || null;
    if (patch.access !== undefined) {
      if (patch.access !== null && !isAccessMode(patch.access)) throw new HttpError(400, "invalid_access", "알 수 없는 권한입니다.");
      next.access = patch.access;
    }
    // The engine is told from its next turn (browse.ts and the adapters).
    if (patch.browser !== undefined) next.browser = Boolean(patch.browser);
    this.saveSession(next);
    if (patch.purpose !== undefined && next.purposeSource === "auto") this.retitle(sessionId, true);
    if (patch.access !== undefined) this.applyAccess(sessionId);
    return this.requireSession(sessionId);
  }

  /** A changed access reaches a running engine at once (and settles approvals it no longer needs). */
  private applyAccess(sessionId: string) {
    const session = this.requireSession(sessionId);
    this.options.browse?.accessChanged(sessionId, this.accessOf(session));
    const adapter = this.adapter(session.provider);
    void adapter.setAccess?.({ ...session, access: this.accessOf(session) }).catch((error: unknown) => {
      this.sink.upsertItem(sessionId, {
        kind: "notice",
        id: `access-failed:${Date.now()}`,
        level: "error",
        text: `권한을 바로 바꾸지 못했습니다(다음 요청부터 적용): ${error instanceof Error ? error.message : String(error)}`,
        at: Date.now(),
      });
    });
  }

  /** Compact the conversation now, as the engine does on its own when the context fills up. */
  /**
   * "이 요청 전으로": a new session in the same work with the conversation up to that request (the
   * engine's own fork, so it remembers exactly that much) and that request back for editing.
   */
  async forkBefore(sessionId: string, itemId: string): Promise<ForkResult> {
    const session = this.requireSession(sessionId);
    if (session.status !== "idle" && session.status !== "error") throw new HttpError(409, "session_busy", "응답이 끝난 뒤에 갈래를 만들 수 있습니다.");
    const items = this.loadItems(sessionId);
    const at = items.findIndex((item) => item.id === itemId);
    const request = items[at];
    if (!request || request.kind !== "user") throw new HttpError(404, "request_not_found", "그 요청을 찾지 못했습니다.");
    const before = items.slice(0, at);
    const keep = { turns: before.filter((item) => item.kind === "turnEnd" && !item.office).length, requests: before.filter((item) => item.kind === "user" && !item.office).length };
    const work = this.requireWork(session.workId);
    const adapter = this.adapter(session.provider);
    let nativeSessionId: string | null = null;
    // Before the first request there is nothing to keep: the new session starts empty.
    if (session.nativeSessionId && keep.requests > 0) {
      if (!adapter.forkNative) throw new HttpError(400, "fork_unsupported", "이 엔진은 갈래를 만들 수 없습니다.");
      nativeSessionId = await adapter.forkNative({ ...session, access: this.accessOf(session) }, this.engineWork(session, work), keep).catch((error: unknown) => {
        throw new HttpError(409, "fork_failed", `갈래를 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    const created = this.createSession(work.id, { provider: session.provider, workspaceId: session.workspaceId, purpose: `${session.purpose} · 갈래`.slice(0, 80), model: session.model, effort: session.effort, access: session.access });
    const kept = before.filter((item) => !(item.kind === "approval" && item.decision === null));
    const note: TranscriptItem = { kind: "notice", id: `fork:${itemId}`, level: "info", text: `「${session.purpose}」의 ${keep.requests + 1}번째 요청 전에서 갈라졌습니다. 그 요청을 입력창에 되돌려 두었습니다.`, at: Date.now() };
    for (const item of [...kept, note]) this.store.saveItem(created.id, item);
    this.transcripts.delete(created.id);
    this.saveSession({ ...this.requireSession(created.id), nativeSessionId, purposeSource: "user", preview: session.preview, previewAt: session.previewAt, seenAt: Date.now() });
    return { session: this.requireSession(created.id), text: request.text };
  }

  /** "가져오기": conversations an engine keeps on this computer, with the session continuing each here. */
  async importCandidates(provider: Provider, query: string): Promise<ImportCandidate[]> {
    const adapter = this.adapter(provider);
    if (!adapter.listNative) return [];
    const here = new Map([...this.sessions.values()].filter((session) => session.provider === provider && session.nativeSessionId).map((session) => [session.nativeSessionId!, session.id]));
    // A conversation whose folder is gone cannot go on (the engine resumes in it), so it is not offered.
    return (await adapter.listNative(query))
      .filter((entry) => entry.cwd && existsSync(entry.cwd))
      .slice(0, 100)
      .map((entry) => ({ provider, ...entry, sessionId: here.get(entry.nativeSessionId) ?? null }));
  }

  /**
   * Continue such a conversation here: a session bound to it (the next request resumes it), its
   * record as the transcript, in the work of its folder (a new work when there is none).
   */
  async importSession(request: ImportRequest): Promise<Session> {
    const continuing = [...this.sessions.values()].find((session) => session.provider === request.provider && session.nativeSessionId === request.nativeSessionId);
    if (continuing) return continuing;
    const adapter = this.adapter(request.provider);
    if (!adapter.nativeHistory) throw new HttpError(400, "import_unsupported", "이 엔진의 대화는 가져올 수 없습니다.");
    const history = await adapter.nativeHistory(request.nativeSessionId).catch((error: unknown) => {
      throw new HttpError(404, "import_missing", `대화를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    });
    // The engine resumes in the folder the conversation ran in, so it has to be there.
    if (!history.cwd || !existsSync(history.cwd)) throw new HttpError(409, "import_folder_missing", `이 대화의 작업 폴더가 없습니다: ${history.cwd ?? "알 수 없음"}`);
    const workspace = this.workspaces.list().filter((entry) => entry.hostId === this.options.hostId && !entry.archivedAt && !entry.removedAt && resolve(entry.cwd) === resolve(history.cwd!) && !this.works.get(entry.workId)?.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const work = (workspace ? this.works.get(workspace.workId) : undefined) ??
      [...this.works.values()].filter((entry) => entry.cwd === history.cwd && !entry.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
      this.createWork({ title: basename(history.cwd) || history.title, cwd: history.cwd });
    const created = this.createSession(work.id, { provider: request.provider, workspaceId: workspace?.id, purpose: history.title.slice(0, 60) });
    const engine = request.provider === "claude" ? "Claude Code" : "Codex";
    const when = new Date(history.updatedAt).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
    const items: TranscriptItem[] = [
      { kind: "notice", id: "imported", level: "info", text: `${engine}에서 가져온 대화입니다(마지막 ${when}). 여기서 이어 쓰면 같은 대화로 이어집니다.`, at: history.items[0]?.at ?? history.updatedAt },
      ...history.items,
    ];
    for (const item of items) this.store.saveItem(created.id, item);
    this.transcripts.delete(created.id);
    const last = [...history.items].reverse().find((item): item is Extract<TranscriptItem, { kind: "assistant" }> => item.kind === "assistant");
    this.saveSession({
      ...this.requireSession(created.id),
      nativeSessionId: request.nativeSessionId,
      purposeSource: "user",
      preview: last ? previewOf(last.text) : null,
      previewAt: last ? history.updatedAt : null,
      seenAt: Date.now(),
    });
    return this.requireSession(created.id);
  }

  /** "/" in the input: the session's engine commands and skills (none when the engine has no list). */
  async commands(sessionId: string) {
    const session = this.requireSession(sessionId);
    const adapter = this.adapter(session.provider);
    if (!adapter.commands) return [];
    return adapter.commands({ ...session, access: this.accessOf(session) }, this.engineWork(session, this.requireWork(session.workId)));
  }

  async compact(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (session.status !== "idle" && session.status !== "error") throw new HttpError(409, "session_busy", "응답이 끝난 뒤에 압축할 수 있습니다.");
    const adapter = this.adapter(session.provider);
    if (!session.nativeSessionId || !adapter.compact) throw new HttpError(409, "nothing_to_compact", "아직 압축할 대화가 없습니다.");
    const work = this.requireWork(session.workId);
    const started = await adapter.compact({ ...session, access: this.accessOf(session) }, this.engineWork(session, work));
    if (!started) throw new HttpError(409, "nothing_to_compact", "지금은 압축할 수 없습니다.");
    return { ok: true };
  }

  async send(
    sessionId: string,
    requestId: string,
    text: string,
    refs: DocRef[] = [],
    from: { sessionId: string; label: string } | null = null,
    create: CreateTarget | null = null,
    mode: "auto" | "steer" | "queue" = "auto",
    options: SendOptions = {},
  ): Promise<SendResult> {
    const identity = JSON.stringify([sessionId, text.trim(), refs, from, create, mode, options]);
    return this.sendGate.run(sessionId, requestId, identity, (release) => this.sendPrepared(sessionId, requestId, text, refs, from, create, mode, options, release));
  }

  private async sendPrepared(
    sessionId: string, requestId: string, text: string, refs: DocRef[],
    from: { sessionId: string; label: string } | null, create: CreateTarget | null,
    mode: "auto" | "steer" | "queue", options: SendOptions, releasePreparation: () => void,
  ): Promise<SendResult> {
    const session = this.requireSession(sessionId);
    const attachments = options.attachments ?? [];
    const plan = options.plan === true;
    const relay = options.relay ?? null;
    const notes = options.notes ?? [];
    const trimmed = text.trim() || (attachments.length ? "첨부한 파일을 봐 주세요." : "");
    if (!requestId) throw new HttpError(400, "missing_request_id", "requestId가 필요합니다.");
    if (!trimmed) throw new HttpError(400, "empty_message", "보낼 내용이 없습니다.");
    // Checked up front: a request is never half sent because a file went missing.
    const files = this.attachments.resolve(attachments);
    const fingerprint = requestFingerprint(trimmed, refs, create, attachments, notes);
    const seen = this.store.findRequest(requestId);
    if (seen) {
      if (seen.sessionId !== sessionId || seen.textHash !== fingerprint) {
        throw new HttpError(409, "request_id_conflict", "같은 requestId로 다른 요청을 보냈습니다.");
      }
      return { duplicate: true, delivery: "turn" };
    }
    const queued = session.queued.find((entry) => entry.id === requestId);
    if (queued) {
      if (requestFingerprint(queued.text, queued.refs, queued.create, queued.attachments ?? [], queued.notes ?? []) !== fingerprint) throw new HttpError(409, "request_id_conflict", "같은 requestId로 다른 대기 요청을 보냈습니다.");
      return { duplicate: true, delivery: "queued" };
    }
    // Anything else sent to a linked session comes from the user: it pauses the link.
    if (!relay) this.links.userInput(sessionId);
    const work = this.requireWork(session.workId);
    if (session.workspaceId) this.workspaces.requireActive(session.workspaceId, work.id);
    const execution = this.engineWork(session, work);
    if (session.workspaceId) this.preparation.assertAgentReady(session.workspaceId);
    // A drawing is a turn of its own: never steered in or kept for later without its instructions.
    if (options.engineText && session.status !== "idle" && session.status !== "error") throw new HttpError(409, "session_busy", "이 세션이 일하는 중입니다. 끝난 뒤에 다시 보내 주세요.");
    if (session.status !== "idle" && session.status !== "error") {
      if (relay) throw new HttpError(409, "session_busy", "받을 세션이 아직 응답 중입니다.");
      // The engine is working. A request steers into the running turn (the engine takes it at its
      // next step) when it can; otherwise it waits and becomes the next turn ("끝나면 보내기").
      const adapter = this.adapter(session.provider);
      // A request to plan first is a turn of its own: it waits for the running one.
      const steerable =
        !this.office.busy(sessionId) &&
        mode !== "queue" &&
        !plan &&
        Boolean(adapter.steer) &&
        (session.status === "running" || session.status === "starting") &&
        !from &&
        !create &&
        !refs.some((ref) => ref.mode === "edit");
      if (steerable) {
        const pinned: { ref: DocRef; pinned: string; pinnedView: string | null; proposal: Proposal | null }[] = [];
        for (const ref of refs) pinned.push({ ref, ...(await this.documents.prepare(ref, sessionId, requestId, execution.cwd)) });
        const entry: Steered = { requestId, text: trimmed, refs, attachments, item: null, dropped: false };
        const steering = this.steering.get(sessionId) ?? new Map<string, Steered>();
        this.steering.set(sessionId, steering.set(requestId, entry));
        const read = notes.length && this.noteHook ? this.noteHook(notes, execution.cwd, sessionId) : null;
        const steered = await adapter.steer!(session, this.engineWork(session, work), this.engineText(trimmed, pinned, execution.cwd, null, null, read?.prompt), requestId, files).catch(() => false);
        if (steered) {
          this.store.saveRequest(requestId, sessionId, fingerprint);
          entry.item = {
            kind: "user",
            id: `user:${requestId}`,
            text: trimmed,
            at: Date.now(),
            steered: true,
            ...(refs.length ? { refs: refs.map((ref) => this.documents.summary(ref)) } : {}),
            ...(attachments.length ? { attachments } : {}),
            ...(read?.refs.length ? { notes: read.refs } : {}),
          };
          this.sink.upsertItem(sessionId, entry.item);
          if (entry.dropped) this.requeueDropped(sessionId, [entry]);
          return { duplicate: false, delivery: "steered" };
        }
        steering.delete(requestId);
      }
      const current = this.requireSession(sessionId);
      if (current.status !== "idle" && current.status !== "error") {
        const waiting: QueuedMessage = {
          id: requestId,
          text: trimmed,
          refs,
          create,
          at: Date.now(),
          ...(attachments.length ? { attachments } : {}),
          ...(plan ? { plan: true } : {}),
          ...(notes.length ? { notes } : {}),
        };
        this.saveSession({ ...current, queued: [...current.queued, waiting] });
        return { duplicate: false, delivery: "queued" };
      }
      // The turn ended meanwhile: this request starts the next one.
    }
    const officeContext = this.office.nativeContext(sessionId);
    this.steering.delete(sessionId);
    // A plan still waiting for the go-ahead is passed over by a new request.
    this.expirePlans(sessionId);
    // Pin each document: the engine reads exactly this revision; edits go to a working copy.
    const prepared: { ref: DocRef; pinned: string; pinnedView: string | null; proposal: Proposal | null }[] = [];
    for (const ref of refs) prepared.push({ ref, ...(await this.documents.prepare(ref, sessionId, requestId, execution.cwd)) });
    // A new document: a free name in the work folder now, tracked with its sources after the turn.
    let created: PendingCreate | null = null;
    if (create) {
      const template = create.template ? await this.userSkills.templateSnapshot(create.template.skillId, this.skillScope(sessionId)) : null;
      if (template && (template.sha256 !== create.template!.sha256 || template.skillSha256 !== create.template!.skillSha256 || template.format !== create.format)) throw new HttpError(409, "template_changed", "선택한 양식이나 설명이 바뀌었습니다. 미리보기에서 다시 선택해 주세요.");
      created = this.creations.reserve({ requestId, sessionId, workId: work.id, workspaceId: session.workspaceId ?? null, fingerprint, cwd: execution.cwd, target: create, sources: refs.map((ref) => ({ artifactId: ref.artifactId, revision: ref.revision })) }, template ? { ...template, skillDir: template.skill.dir } : null);
      this.creating.set(sessionId, created);
    }
    const read = notes.length && this.noteHook ? this.noteHook(notes, execution.cwd, sessionId) : null;
    this.store.saveRequest(requestId, sessionId, fingerprint);
    if (created) this.creations.update(requestId, { state: "sent" });
    const baseText = options.engineText ?? (relay ? `${relay.header}\n\n${trimmed}` : this.engineText(trimmed, prepared, execution.cwd, from, created, read?.prompt));
    // What changed in the project since this session's last request (people's edits, other
    // sessions' revisions, the note), before the request; relays and drawings carry their own.
    const told = !relay && !options.engineText;
    const change = told ? (this.changeHook?.(session, work, options.omitChanges ?? []) ?? null) : null;
    const engineText = officeContext.text + (change ? `${change}\n\n${baseText}` : baseText);
    this.sink.upsertItem(sessionId, {
      kind: "user",
      id: `user:${requestId}`,
      text: trimmed,
      at: Date.now(),
      ...(plan ? { plan: true } : {}),
      ...(refs.length ? { refs: refs.map((ref) => this.documents.summary(ref)) } : {}),
      ...(read?.refs.length ? { notes: read.refs } : {}),
      ...(from ? { from } : {}),
      ...(created ? { create: { ...created.target, name: basename(created.path), path: created.path } } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(options.draw ? { draw: options.draw } : {}),
      ...(relay ? { link: relay.hop } : {}),
      ...(options.scheduled ? { scheduled: true } : {}),
    });
    this.turnStarted.set(sessionId, Date.now());
    this.turnRequest.set(sessionId, requestId);
    if (plan) this.planning.set(sessionId, requestId);
    else this.planning.delete(sessionId);
    this.sink.updateSession(sessionId, { status: "starting", activity: plan ? "계획 세우는 중" : "응답 준비 중", lastError: null });
    // A relayed message does not switch the conversation on screen (it goes back and forth), nor
    // does a drawing made for another conversation.
    this.saveWork({ ...work, activeSessionId: options.activate === false || relay ? work.activeSessionId : sessionId, updatedAt: Date.now() });
    releasePreparation();
    try {
      const current = this.requireSession(sessionId);
      await this.adapter(session.provider).send({ ...current, access: this.accessOf(current), plan }, this.engineWork(current, work), engineText, requestId, files);
      officeContext.accept();
      if (told) this.toldHook?.(current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const entry of prepared) if (entry.proposal) this.documents.discardProposal(entry.proposal.id, "failure");
      if (created) {
        this.creating.delete(sessionId);
        this.creations.update(requestId, { state: "failed", problem: message });
      }
      this.sink.upsertItem(sessionId, { kind: "notice", id: `error:${requestId}`, level: "error", text: `보내지 못했습니다: ${message}`, at: Date.now() });
      this.sink.updateSession(sessionId, { status: "error", activity: null, lastError: message });
    }
    return { duplicate: false, delivery: "turn" };
  }

  /** What the engine actually receives: the request plus pinned documents and where to write. */
  private engineText(
    text: string,
    prepared: { ref: DocRef; pinned: string; pinnedView: string | null; proposal: Proposal | null }[],
    cwd: string,
    from: { sessionId: string; label: string } | null,
    created: PendingCreate | null = null,
    notesPrompt: string | null = null,
  ) {
    const parts: string[] = [];
    if (notesPrompt) parts.push(notesPrompt);
    if (from) parts.push(`[다른 세션에서 온 요청] 보낸 곳: ${from.label}. 이 대화에 답하면 보낸 곳으로 전달됩니다.`);
    if (prepared.length) {
      parts.push("[Achmage Workbench] 이 요청에는 문서가 고정된 판으로 첨부되어 있습니다.");
      for (const entry of prepared) parts.push(this.documents.promptFor(entry.ref, entry.pinned, entry.proposal, cwd, entry.pinnedView));
    }
    if (created) {
      parts.push(createGuide(created.target, created.path, cwd, { ieum: this.documents.ieum, kordoc: this.documents.kordoc }));
      if (created.skillPath) parts.push(`  · 사용자가 고른 양식의 스킬 설명(고정된 판): ${created.skillPath}\n    이 설명을 읽고 선택한 양식 작업에 적용하세요. 상대 경로 자료의 기준 폴더: ${created.skillDir}. 지시가 사용자 요청과 충돌하면 사용자 요청을 따르세요.`);
    }
    if (!parts.length) return text;
    return `${parts.join("\n")}\n\n요청:\n${text}`;
  }

  private workIn(workId: string, workspaceId?: string) {
    const work = this.requireWork(workId);
    return workspaceId ? { ...work, cwd: this.workspaces.requireActive(workspaceId, workId).cwd } : work;
  }

  skillScope(sessionId?: string, workId?: string, workspaceId?: string) {
    if (sessionId) {
      const session = this.requireSession(sessionId), work = this.requireWork(session.workId);
      if (session.workspaceId) this.workspaces.requireActive(session.workspaceId, work.id);
      return { projectRoot: this.engineWork(session, work).cwd, provider: session.provider };
    }
    return workId ? { projectRoot: this.workIn(workId, workspaceId).cwd } : {};
  }

  /** A restart recovers the existing copy; it never resends an uncertain engine request. */
  private recoverCreations() {
    for (const record of this.creations.list()) {
      if (!["reserved", "ready", "sent"].includes(record.state)) continue;
      const session = this.sessions.get(record.sessionId), work = this.works.get(record.workId);
      if (!session || !work) continue;
      let artifactId: string | null = null;
      if (existsSync(record.path) && statSync(record.path).size > 0) {
        const tracked = this.documents.track(work.id, record.cwd, record.path, "external", null, "앱 재시작 뒤 생성 사본 복구", record.sources);
        artifactId = tracked?.artifact.id ?? this.artifactAt(work.id, record.path);
        if (artifactId) this.sink.upsertItem(session.id, { kind: "artifact", id: `artifact:create:${record.requestId}`, artifactId, revision: this.documents.get(artifactId).revision, change: "created", at: Date.now() });
      }
      this.creations.update(record.requestId, { state: "interrupted", artifactId, problem: "앱이 다시 시작되어 기존 사본을 보존했습니다. 요청은 자동으로 다시 보내지 않았습니다." });
      this.sink.upsertItem(session.id, { kind: "notice", id: `create-recovered:${record.requestId}`, level: "info", text: `중단된 문서 생성: ${record.path}. 기존 사본을 확인한 뒤 이어서 편집할 수 있습니다.`, at: Date.now() });
    }
  }

  /** Open a file of the work folder (or any path the user picked) as a tracked document. */
  openFile(workId: string, rawPath: string, workspaceId?: string) {
    const work = this.workIn(workId, workspaceId);
    if (!rawPath.trim()) throw new HttpError(400, "missing_path", "파일 경로가 필요합니다.");
    const path = isAbsolute(rawPath) ? rawPath : resolve(work.cwd, rawPath);
    if (!existsSync(path)) throw new HttpError(404, "file_missing", "파일이 없습니다.");
    if (!formatOf(path)) throw new HttpError(415, "unsupported_format", "Markdown·HTML·PDF·한글(HWPX·HWP)·워드·PPT·엑셀·마인드맵(.xmind)·전자책(.epub)·텍스트·디자인(.design.json)만 열 수 있습니다.");
    const tracked = this.documents.track(work.id, work.cwd, path, "external", null, "작업 폴더에서 열기");
    if (tracked) return tracked.artifact;
    const existing = this.documents.list().find((artifact) => artifact.workId === work.id && artifact.path === path);
    if (!existing) throw new HttpError(415, "unsupported_format", "문서로 열 수 없는 파일입니다.");
    return this.documents.check(existing.id);
  }

  /**
   * A new page: a Markdown file in the work folder, opened at once (Notion's "+" on a row). Never
   * overwrites: a number is added to a taken name.
   */
  createPage(workId: string, name: string, workspaceId?: string) {
    const work = this.workIn(workId, workspaceId);
    const stem = (name.trim() || "제목 없음").replace(/[\\/:*?"<>|]/g, "_").replace(/\.md$/i, "").slice(0, 80);
    mkdirSync(work.cwd, { recursive: true });
    let path = resolve(work.cwd, `${stem}.md`);
    for (let index = 2; existsSync(path); index += 1) path = resolve(work.cwd, `${stem} ${index}.md`);
    writeFileSync(path, `# ${stem}\n\n`, { flag: "wx" });
    const tracked = this.documents.track(work.id, work.cwd, path, "user", null, "새 페이지");
    if (!tracked) throw new HttpError(500, "page_not_tracked", "페이지를 만들지 못했습니다.");
    return tracked.artifact;
  }

  /** A new design file in the work folder (never overwrites: a number is added to a taken name). */
  createDesign(workId: string, name: string, preset: DesignPreset, text: string | null = null, workspaceId?: string) {
    const work = this.workIn(workId, workspaceId);
    const problem = text === null ? null : designProblem(text);
    if (problem) throw new HttpError(422, "invalid_design", `디자인을 만들지 않았습니다: ${problem}`);
    const stem = (name.trim() || "새 디자인").replace(/[\\/:*?"<>|]/g, "_").replace(/\.design\.json$/i, "").slice(0, 80);
    let path = resolve(work.cwd, `${stem}${DESIGN_EXTENSION}`);
    for (let index = 2; existsSync(path); index += 1) path = resolve(work.cwd, `${stem} ${index}${DESIGN_EXTENSION}`);
    writeFileSync(path, text ?? blankDesign(preset), { flag: "wx" });
    const tracked = this.documents.track(work.id, work.cwd, path, "user", null, "새 디자인");
    if (!tracked) throw new HttpError(500, "design_not_tracked", "디자인 파일을 만들지 못했습니다.");
    return tracked.artifact;
  }

  /**
   * A file the design editor exported (PNG, PDF, video…): written next to the design without
   * overwriting anything, and tracked when it is a document format (a PDF opens in the app).
   */
  exportDesign(artifactId: string, data: Buffer, rawName: string) {
    const design = this.documents.check(artifactId);
    if (design.format !== "design") throw new HttpError(400, "not_design", "디자인 문서가 아닙니다.");
    const work = this.requireWork(design.workId);
    const name = basename(rawName.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim() || "내보내기";
    if (data.length === 0) throw new HttpError(400, "export_empty", "빈 파일입니다.");
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    let path = join(dirname(design.path), name);
    for (let index = 2; existsSync(path); index += 1) path = join(dirname(design.path), `${stem} ${index}${extension}`);
    writeFileSync(path, data, { flag: "wx" });
    const tracked = this.documents.track(work.id, work.cwd, path, "user", null, `「${design.name}」에서 내보냄`);
    return { path, name: basename(path), artifactId: tracked?.artifact.id ?? null };
  }

  /**
   * PDF page edits through PDFCraft (rotate, delete, move). The result is a new file next to the
   * original; the original and its revisions stay untouched.
   */
  async editPdf(artifactId: string, edit: { rotate?: { pages: number[]; degrees: number }[]; delete?: number[]; move?: { from: number; to: number }[] }) {
    const artifact = this.documents.check(artifactId);
    if (artifact.format !== "pdf") throw new HttpError(400, "not_pdf", "PDF 문서가 아닙니다.");
    const cli = findPdfcraft()?.path;
    if (!cli) throw new HttpError(501, "pdfcraft_missing", "PDF 편집 도구(PDFCraft)를 찾지 못했습니다. 앱을 다시 설치해 주세요.");
    const args = ["edit", this.documents.revisionPath(artifactId, artifact.revision)];
    const rotations = (edit.rotate ?? []).filter((entry) => entry.pages.length && [90, 180, 270].includes(entry.degrees));
    for (const entry of rotations) args.push("--rotate", `${entry.pages.join(",")}:${entry.degrees}`);
    if (edit.delete?.length) args.push("--delete", edit.delete.join(","));
    for (const entry of edit.move ?? []) args.push("--move", `${entry.from}:${entry.to}`);
    if (args.length === 2) throw new HttpError(400, "no_edit", "바꿀 내용이 없습니다.");
    const extension = extname(artifact.path);
    const stem = artifact.path.slice(0, -extension.length);
    let out = `${stem}.편집${extension}`;
    for (let index = 2; existsSync(out); index += 1) out = `${stem}.편집${index}${extension}`;
    args.push("--out", out);
    await new Promise<void>((done, fail) =>
      execFile(cli, args, { timeout: 60_000 }, (error, _stdout, stderr) =>
        error ? fail(new HttpError(500, "pdfcraft_failed", `PDFCraft 편집 실패: ${String(stderr || error.message).slice(0, 300)}`)) : done(),
      ),
    );
    const work = this.requireWork(artifact.workId);
    const tracked = this.documents.track(work.id, work.cwd, out, "user", null, `${artifact.name} r${artifact.revision}에서 PDFCraft로 편집`);
    if (!tracked) throw new HttpError(500, "pdfcraft_failed", "편집 결과를 읽지 못했습니다.");
    return tracked.artifact;
  }

  /** Files an engine wrote: documents get a new revision and a card in the conversation. */
  /** The new document a request asked for: track it with its sources, or say that it is missing or broken. */
  private finishCreate(sessionId: string, status: "completed" | "interrupted" | "failed", made: Provenance) {
    const created = this.creating.get(sessionId);
    if (!created) return;
    this.creating.delete(sessionId);
    const session = this.sessions.get(sessionId);
    const project = session ? this.works.get(session.workId) : undefined;
    const work = session && project ? this.engineWork(session, project) : undefined;
    if (!work) return;
    const name = basename(created.path);
    if (!existsSync(created.path) || statSync(created.path).size === 0) {
      this.creations.update(created.requestId, { state: status === "completed" ? "failed" : status, problem: "문서 내용이 만들어지지 않았습니다." });
      if (status === "completed") {
        this.sink.upsertItem(sessionId, { kind: "notice", id: `create-missing:${created.requestId}`, level: "error", text: `새 문서 ${name}이(가) 만들어지지 않았습니다.`, at: Date.now() });
      }
      return;
    }
    const sources = created.sources.map((source) => this.documents.list().find((artifact) => artifact.id === source.artifactId)?.name).filter(Boolean);
    const note = sources.length ? `새 문서 · ${sources.join(", ")}에서` : "새 문서";
    const tracked = this.documents.track(work.id, work.cwd, created.path, "engine", sessionId, note, created.sources, made);
    const artifactId = tracked?.artifact.id ?? this.artifactAt(work.id, created.path);
    this.creations.update(created.requestId, { state: status, artifactId });
    if (artifactId) {
      this.sink.upsertItem(sessionId, {
        kind: "artifact",
        id: `artifact:create:${created.requestId}`,
        artifactId,
        revision: this.documents.get(artifactId).revision,
        change: "created",
        at: Date.now(),
      });
    }
    void this.documents.newDocumentProblem(created.path).then((problem) => {
      if (problem) this.sink.upsertItem(sessionId, { kind: "notice", id: `create-problem:${created.requestId}`, level: "error", text: `${name}: ${problem}`, at: Date.now() });
    });
  }

  /**
   * Engines also write files through shell commands (a script, `cat >`), which report no paths.
   * After a turn, documents in the work folder that changed since the turn began are tracked too.
   */
  private trackChangedFiles(sessionId: string, made: Provenance) {
    const started = this.turnStarted.get(sessionId);
    this.turnStarted.delete(sessionId);
    const session = this.sessions.get(sessionId);
    const project = session ? this.works.get(session.workId) : undefined;
    const work = session && project ? this.engineWork(session, project) : undefined;
    if (!started || !work || !existsSync(work.cwd)) return;
    const changed = recentDocuments(work.cwd, started - 2000);
    if (changed.length) this.trackFiles(sessionId, `scan:${started}`, changed, made);
  }

  /**
   * A step keeps the pictures it has when the engine reports it again, and a finished command shows
   * the pictures it made (image files it names that changed during this turn, e.g. screenshots).
   */
  private withStepImages(sessionId: string, item: Extract<TranscriptItem, { kind: "tool" }>, items: TranscriptItem[]) {
    const before = items.find((entry) => entry.id === item.id);
    let images = item.images ?? (before?.kind === "tool" ? before.images : undefined);
    if (item.tool === "command" && item.status === "completed" && !(before?.kind === "tool" && before.status === "completed")) {
      const session = this.sessions.get(sessionId);
      const project = session ? this.works.get(session.workId) : undefined;
      const work = session && project ? this.engineWork(session, project) : undefined;
      const started = this.turnStarted.get(sessionId);
      if (work && started) {
        const found = imagesNamed(`${item.title}\n${item.output ?? ""}`, work.cwd, started - 2000)
          .map((path) => keepImage(this.attachments, { path }))
          .filter((image) => image !== null);
        if (found.length) images = withImages(images, found);
      }
    }
    return images?.length ? { ...item, images } : item;
  }

  /** `made`: the turn's provenance (from its end); during the turn, what the engine reported so far. */
  private trackFiles(sessionId: string, itemId: string, paths: string[], made?: Provenance) {
    const session = this.sessions.get(sessionId);
    const project = session ? this.works.get(session.workId) : undefined;
    const work = session && project ? this.engineWork(session, project) : undefined;
    if (!session || !work) return;
    const provenance = made ?? { model: session.engineModel, effort: session.engineEffort, requestId: this.turnRequest.get(sessionId) ?? null };
    for (const path of paths) {
      if (isWorkbenchPath(path)) continue;
      try {
        const tracked = this.documents.track(work.id, work.cwd, path, "engine", sessionId, null, null, provenance);
        if (!tracked) continue;
        this.sink.upsertItem(sessionId, {
          kind: "artifact",
          id: `artifact:${itemId}:${tracked.artifact.id}`,
          artifactId: tracked.artifact.id,
          revision: tracked.artifact.revision,
          change: tracked.change,
          at: Date.now(),
        });
      } catch {
        // A file that cannot be read now is simply not shown as a document.
      }
    }
  }

  /** A turn ended: working copies become proposals, and answered handoffs go back to their source. */
  /**
   * A planning turn ended: unless the engine asked for the go-ahead itself (Claude's plan mode ends
   * with one), the plan above waits for it here.
   */
  private planEnded(sessionId: string, status: "completed" | "interrupted" | "failed") {
    const requestId = this.planning.get(sessionId);
    this.planning.delete(sessionId);
    if (!requestId || status !== "completed") return;
    const items = this.loadItems(sessionId);
    const start = items.findIndex((item) => item.id === `user:${requestId}`);
    if (start < 0 || items.slice(start).some((item) => item.kind === "approval" && item.plan)) return;
    this.sink.upsertItem(sessionId, { kind: "approval", id: `plan:${requestId}`, title: "이 계획대로 진행할까요?", detail: null, reason: null, decision: null, plan: true, at: Date.now() });
  }

  /** Plans left waiting when the user writes something else instead. */
  private expirePlans(sessionId: string) {
    for (const item of this.loadItems(sessionId)) {
      if (item.kind === "approval" && item.plan && item.decision === null && item.id.startsWith("plan:")) this.sink.upsertItem(sessionId, { ...item, decision: "expired" });
    }
  }

  /**
   * A turn ended — completed, stopped, failed, its engine died or the app restarted (`end.cause`): the
   * plan waits for the go-ahead, the waiting requests stay unless it completed, the documents it made
   * are tracked with what made them, a working copy it changed becomes a proposal (marked when the
   * turn was cut short), and a request another session sent it gets its answer.
   */
  private afterTurn(sessionId: string, end: Extract<TranscriptItem, { kind: "turnEnd" }>) {
    const { status } = end;
    const broke = turnBreakOf(status, end.cause);
    const made = provenanceOf(end);
    this.planEnded(sessionId, status);
    const waiting = broke ? this.holdQueued(sessionId) : 0;
    if (broke && waiting) this.sink.upsertItem(sessionId, { kind: "notice", id: `queue-held:${Date.now()}`, level: "info", text: heldNotice(broke, waiting), at: Date.now() });
    this.finishCreate(sessionId, status, made);
    this.images.afterTurn(sessionId, status);
    this.trackChangedFiles(sessionId, made);
    this.turnRequest.delete(sessionId);
    for (const running of this.documents.runningProposals(sessionId)) {
      this.proposalReady(sessionId, this.documents.finishProposal(running.id, { interruptedBy: broke, model: made.model, effort: made.effort }));
    }
    for (const handoff of this.handoffs.values()) {
      if (handoff.targetSessionId !== sessionId || handoff.status !== "sent") continue;
      const items = this.loadItems(sessionId);
      const start = items.findIndex((item) => item.id === `user:${handoff.id}`);
      if (start === -1) continue;
      const reply = items
        .slice(start + 1)
        .flatMap((item) => (item.kind === "assistant" && item.text.trim() ? [item.text.trim()] : []))
        .join("\n\n");
      const answered: Handoff = broke
        ? { ...handoff, status: "failed", reply: reply || null, error: handoffError(broke), answeredAt: Date.now() }
        : { ...handoff, status: "answered", reply: reply || null, answeredAt: Date.now() };
      this.saveHandoff(answered);
    }
  }

  /** A finished working copy in its conversation: the proposal card, or a word that nothing changed. */
  private proposalReady(sessionId: string, proposal: Proposal) {
    if (!this.sessions.has(sessionId)) return;
    if (proposal.status === "pending") {
      this.sink.upsertItem(sessionId, { kind: "proposal", id: `proposal:${proposal.id}`, proposalId: proposal.id, at: Date.now() });
    } else if (proposal.status === "empty") {
      const name = this.documents.get(proposal.artifactId).name;
      this.sink.upsertItem(sessionId, { kind: "notice", id: `proposal-empty:${proposal.id}`, level: "info", text: `${name}: 작업 사본이 바뀌지 않아 수정안이 없습니다.`, at: Date.now() });
    }
  }

  private saveHandoff(handoff: Handoff) {
    this.handoffs.set(handoff.id, handoff);
    this.store.saveHandoff(handoff);
    this.bus.publish({ type: "handoff.upserted", handoff });
  }

  /**
   * "다른 세션에": the request and pinned documents go to another session; its answer comes back
   * as a card in the source conversation. One request, one answer, never an automatic loop.
   */
  async handoff(request: HandoffRequest): Promise<Handoff> {
    const existing = this.handoffs.get(request.requestId);
    if (existing) return existing;
    const source = this.requireSession(request.sourceSessionId);
    const target = this.requireSession(request.targetSessionId);
    if (source.id === target.id) throw new HttpError(400, "same_session", "같은 세션에는 보낼 수 없습니다.");
    if (target.status !== "idle" && target.status !== "error") {
      throw new HttpError(409, "session_busy", "받을 세션이 아직 응답 중입니다. 끝난 뒤에 보내 주세요.");
    }
    const refs = (request.refs ?? []).map((ref) => ({ ...ref, mode: "review" as const }));
    const sourceWork = this.requireWork(source.workId);
    const handoff: Handoff = {
      id: request.requestId,
      sourceSessionId: source.id,
      targetSessionId: target.id,
      text: request.text.trim(),
      refs,
      status: "sent",
      reply: null,
      error: null,
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
      createdAt: Date.now(),
      answeredAt: null,
    };
    this.saveHandoff(handoff);
    this.sink.upsertItem(source.id, { kind: "handoff", id: `handoff:${handoff.id}`, handoffId: handoff.id, at: handoff.createdAt });
    try {
      await this.send(
        target.id,
        request.requestId,
        request.text,
        refs,
        {
          sessionId: source.id,
          label: `${sourceWork.title} · ${source.purpose} (${source.provider === "claude" ? "Claude" : "Codex"})`,
        },
        null,
        "auto",
        { attachments: request.attachments ?? [] },
      );
    } catch (error) {
      this.saveHandoff({ ...handoff, status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return this.handoffs.get(handoff.id)!;
  }

  /**
   * "다시 보내기": a request the other session did not answer (its turn failed, was stopped, or its
   * engine died) goes again, the same words, documents and files, as a new request with its own card.
   */
  async resendHandoff(handoffId: string, requestId: string): Promise<Handoff> {
    const old = this.handoffs.get(handoffId);
    if (!old) throw new HttpError(404, "handoff_not_found", "보낸 요청을 찾지 못했습니다.");
    if (old.resentAs && this.handoffs.has(old.resentAs)) return this.handoffs.get(old.resentAs)!;
    if (old.status !== "failed") throw new HttpError(409, "handoff_not_failed", "답을 받지 못한 요청만 다시 보낼 수 있습니다.");
    let failure: unknown = null;
    try {
      await this.handoff({ requestId, sourceSessionId: old.sourceSessionId, targetSessionId: old.targetSessionId, text: old.text, refs: old.refs, attachments: old.attachments ?? [] });
    } catch (error) {
      failure = error;
    }
    // Sent (or tried): the old card says so, the new one says what it repeats.
    const resent = this.handoffs.get(requestId);
    if (resent && resent.id !== old.id) {
      this.saveHandoff({ ...this.handoffs.get(old.id)!, resentAs: resent.id });
      this.saveHandoff({ ...resent, resentFrom: old.id });
    }
    if (failure) throw failure;
    return this.handoffs.get(requestId)!;
  }

  /**
   * "찾는 길": works, sessions, requests, replies, plans, documents and vault notes by the words
   * typed, ranked and grouped by work (search.ts). Local index only: no model is asked. Archived
   * things are left out unless asked for.
   */
  search(query: string, options: SearchOptions = {}): SearchPage {
    return this.finder.search(query, options);
  }

  /**
   * "마크다운으로 내보내기": the conversation by fixed rules (see export-md.ts). In the work folder it
   * goes to "세션 기록/" and becomes a document of the work (opened, attached, searched like others);
   * a later export of the same conversation updates the same file.
   */
  exportMarkdown(sessionId: string, request: ExportMarkdownRequest): ExportMarkdownResult {
    const session = this.requireSession(sessionId);
    const work = this.engineWork(session, this.requireWork(session.workId));
    const items = this.loadItems(sessionId);
    const folders: string[] = [];
    for (let at = work.folderId; at; at = this.folders.get(at)?.parentId ?? null) folders.unshift(this.folders.get(at)?.name ?? "");
    const markdown = sessionMarkdown({
      session,
      work,
      folders: folders.filter(Boolean),
      items,
      tools: Boolean(request.tools),
      artifactName: (id) => this.documents.list().find((artifact) => artifact.id === id)?.name ?? null,
      proposal: (id) => {
        const proposal = this.documents.listProposals().find((entry) => entry.id === id);
        if (!proposal) return null;
        return { ...proposal, name: this.documents.list().find((artifact) => artifact.id === proposal.artifactId)?.name ?? null };
      },
      handoff: (id) => this.handoffs.get(id) ?? null,
      link: (id) => this.links.get(id),
      sessionLabel: (id) => {
        const target = this.sessions.get(id);
        const targetWork = target ? this.works.get(target.workId) : undefined;
        return target ? `${targetWork?.title ?? ""} · ${target.purpose} (${target.provider === "claude" ? "Claude" : "Codex"})` : null;
      },
    });
    if (request.target === "text") return { markdown, path: null, artifactId: null };
    if (request.target === "path") {
      const path = String(request.path ?? "");
      if (!isAbsolute(path)) throw new HttpError(400, "invalid_path", "저장할 위치가 올바르지 않습니다.");
      const target = /\.(md|markdown)$/i.test(path) ? path : `${path}.md`;
      if (!existsSync(dirname(target))) throw new HttpError(404, "folder_missing", "저장할 폴더가 없습니다.");
      writeAtomic(target, markdown);
      const inside = !relativeOutside(work.cwd, target);
      const tracked = inside ? this.documents.track(work.id, work.cwd, target, "user", null, "세션 기록 내보내기") : null;
      return { markdown, path: target, artifactId: tracked?.artifact.id ?? (inside ? this.artifactAt(work.id, target) : null) };
    }
    const folder = join(work.cwd, "세션 기록");
    mkdirSync(folder, { recursive: true });
    const name = exportFileName(session, items[0]?.at ?? session.createdAt);
    const stem = name.slice(0, -3);
    let path = join(folder, name);
    // The same conversation updates its file; a file of another conversation with the name stays.
    for (let index = 2; existsSync(path) && !exportedFrom(path, session.id); index += 1) path = join(folder, `${stem} ${index}.md`);
    writeAtomic(path, markdown);
    const tracked = this.documents.track(work.id, work.cwd, path, "user", null, "세션 기록 내보내기");
    return { markdown, path, artifactId: tracked?.artifact.id ?? this.artifactAt(work.id, path) };
  }

  private artifactAt(workId: string, path: string) {
    return this.documents.list().find((artifact) => artifact.workId === workId && artifact.path === path)?.id ?? null;
  }

  async interrupt(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (this.office.interrupt(sessionId)) return;
    this.options.browse?.expire(sessionId);
    await this.adapter(session.provider).interrupt(session);
  }

  async answerApproval(sessionId: string, itemId: string, decision: ApprovalDecision) {
    const session = this.requireSession(sessionId);
    if (decision !== "accept" && decision !== "decline") {
      throw new HttpError(400, "invalid_decision", "accept 또는 decline만 가능합니다.");
    }
    // A plan that waits here (the engine's turn is over): going ahead is the next request.
    const plan = itemId.startsWith("plan:") ? this.loadItems(sessionId).find((item) => item.id === itemId) : undefined;
    if (plan?.kind === "approval") {
      if (plan.decision !== null) throw new HttpError(409, "approval_not_pending", "이미 처리되었거나 만료된 승인 요청입니다.");
      this.sink.upsertItem(sessionId, { ...plan, decision });
      if (decision === "accept") await this.send(sessionId, `go-${itemId.slice(5)}`, "계획대로 진행해 주세요.");
      return;
    }
    // The agent browser's own cards are answered there (browse.ts), the rest by the engine.
    const handled = this.options.browse?.answer(sessionId, itemId, decision) || (await this.adapter(session.provider).answerApproval(session, itemId, decision));
    if (!handled) {
      throw new HttpError(409, "approval_not_pending", "이미 처리되었거나 만료된 승인 요청입니다.");
    }
  }

  /** Probe engines after the UI can connect; results arrive as provider.status events. */
  initProviders() {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.init().catch(() => undefined)));
  }

  login(provider: Provider): Promise<LoginStart> {
    return this.adapter(provider).login();
  }

  /** The code a login page showed, for an engine whose login waits for it (Claude Code). */
  async loginCode(provider: Provider, code: string) {
    const adapter = this.adapter(provider);
    if (!adapter.loginCode) throw new HttpError(400, "no_login_code", "이 엔진은 코드를 받지 않습니다.");
    await adapter.loginCode(code).catch((error: unknown) => {
      throw new HttpError(409, "login_code", error instanceof Error ? error.message : String(error));
    });
    return this.engineSetup.decorate(adapter.status());
  }

  async cancelLogin(provider: Provider) {
    const adapter = this.adapter(provider);
    await adapter.cancelLogin?.();
    return this.engineSetup.decorate(adapter.status());
  }

  /** "설치": the latest engine for this user; progress arrives as provider.status events. */
  installEngine(provider: Provider) {
    const adapter = this.adapter(provider);
    if (!this.engineSetup.canInstall()) throw new HttpError(501, "npm_missing", "이 설치본에는 엔진을 설치할 npm이 없습니다.");
    void this.engineSetup.install(provider);
    return this.engineSetup.decorate(adapter.status());
  }

  async refreshProviders(): Promise<ProviderStatus[]> {
    // An engine installed meanwhile (by the user, in a terminal) is found again.
    return Promise.all([...this.adapters.values()].map(async (adapter) => this.engineSetup.decorate(await adapter.refreshStatus())));
  }

  /** Stop watching documents opened in other apps. */
  stopExternalWatches() {
    for (const stop of [...this.external.values()]) stop();
  }

  async shutdown() {
    this.office.close();
    this.scmReviews.stop();
    this.githubFeedback.stop();
    this.githubActions.stop();
    await this.github.close();
    await this.githubActions.drain();
    this.schedules.stop();
    this.stopExternalWatches();
    this.flush();
    await this.worktreeWorkspaces.shutdown();
    await this.preparation.shutdown();
    await this.sourceControl.shutdown();
    await this.terminals.shutdown();
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.shutdown()));
    await this.options.browse?.shutdown();
    await this.skillLibrary.shutdown();
  }

  /** Automatic titles follow the requests (no model call); see titles.ts. */
  private retitle(sessionId: string, fresh = false) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.purposeSource === "auto") {
      const requests = this.requestsOf([sessionId]);
      const current = fresh || DEFAULT_PURPOSE.test(session.purpose) || requests.length <= 1 ? null : session.purpose;
      const purpose = adaptTitle(requests, current);
      if (purpose && purpose !== session.purpose) this.saveSession({ ...session, purpose, updatedAt: Date.now() });
    }
    this.retitleWork(session.workId);
  }

  private retitleWork(workId: string, fresh = false) {
    const work = this.works.get(workId);
    if (!work || work.titleSource !== "auto") return;
    const sessionIds = [...this.sessions.values()].filter((session) => session.workId === workId).map((session) => session.id);
    const requests = this.requestsOf(sessionIds);
    if (!requests.length) return;
    const title = adaptTitle(requests, fresh || requests.length <= 1 ? null : work.title);
    if (title && title !== work.title) this.saveWork({ ...this.requireWork(workId), title });
  }

  /** Requests of the given sessions, oldest first (what another session wrote is not the user's request). */
  private requestsOf(sessionIds: string[]) {
    return sessionIds
      .flatMap((id) => this.loadItems(id).flatMap((item) => (item.kind === "user" && !item.peer && !item.link ? [{ at: item.at, text: item.text }] : [])))
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.text);
  }

  /** An interrupted or failed turn may never send a final message; stop showing it as in progress. */
  private finishStreaming(sessionId: string) {
    for (const item of this.loadItems(sessionId)) {
      if (item.kind === "assistant" && item.streaming) {
        this.sink.upsertItem(sessionId, { ...item, streaming: false });
      } else if (item.kind === "tool" && item.status === "running") {
        this.sink.upsertItem(sessionId, { ...item, status: "failed" });
      }
    }
  }

  private loadItems(sessionId: string) {
    let items = this.transcripts.get(sessionId);
    if (!items) {
      items = this.store.items(sessionId);
      this.transcripts.set(sessionId, items);
    }
    return items;
  }

  /** Streaming deltas are persisted in batches; the final item upsert also persists. */
  private markDirty(sessionId: string, itemId: string) {
    let set = this.dirtyItems.get(sessionId);
    if (!set) {
      set = new Set();
      this.dirtyItems.set(sessionId, set);
    }
    set.add(itemId);
    this.flushTimer ??= setTimeout(() => this.flush(), 500);
  }

  private flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const [sessionId, ids] of this.dirtyItems) {
      for (const item of this.loadItems(sessionId)) {
        if (ids.has(item.id)) this.store.saveItem(sessionId, item);
      }
    }
    this.dirtyItems.clear();
  }

  private saveWork(work: Work) {
    this.works.set(work.id, work);
    this.store.saveWork(work);
    this.bus.publish({ type: "work.upserted", work });
  }

  private saveSession(session: Session) {
    this.sessions.set(session.id, session);
    this.store.saveSession(session);
    this.bus.publish({ type: "session.upserted", session });
    this.options.browse?.sessionChanged(session);
  }

  /** The folder a work runs in (images pasted into its documents are kept under it). */
  workCwd(workId: string) {
    return this.requireWork(workId).cwd;
  }

  private requireWork(workId: string) {
    const work = this.works.get(workId);
    if (!work) throw new HttpError(404, "work_not_found", "작업을 찾지 못했습니다.");
    return work;
  }

  /** Folders, works and sessions as they are now, for feature modules (pkm.ts); not to be changed. */
  get view(): { folders: ReadonlyMap<string, Folder>; works: ReadonlyMap<string, Work>; sessions: ReadonlyMap<string, Session> } {
    return { folders: this.folders, works: this.works, sessions: this.sessions };
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "session_not_found", "세션을 찾지 못했습니다.");
    return session;
  }
}
