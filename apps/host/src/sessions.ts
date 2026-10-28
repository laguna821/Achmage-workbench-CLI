import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  PROTOCOL_VERSION,
  accessFor,
  applyItemEvent,
  isAccessMode,
  type AccessMode,
  type ApprovalDecision,
  type CreateSessionRequest,
  type CreateWorkRequest,
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
  type ImportRequest,
  type Attachment,
  type SendResult,
  type ExportMarkdownResult,
  type SearchHit,
  type SearchResult,
  type UpdateFolderRequest,
  type UpdateWorkRequest,
  type Handoff,
  type HandoffRequest,
  type LinkHop,
  type Proposal,
  type RequestDraw,
  type UpdateSessionRequest,
  type Work,
} from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import { HttpError } from "./errors.ts";
import { Documents, isWorkbenchPath } from "./artifacts.ts";
import type { Kordoc } from "./kordoc.ts";
import type { AdapterSink, LoginStart, ProviderAdapter } from "./providers/types.ts";
import type { Store } from "./store.ts";
import { adaptTitle, titleFor } from "./titles.ts";
import { blankDesign, designProblem, type DesignPreset } from "./design.ts";
import { IeumOffice, installIeumOffice, type InstallProgress } from "./ieumoffice.ts";
import { findHop, openInHop, openWithDesktop } from "./hop.ts";
import { createGuide, reservePath } from "./create.ts";
import { copyMcp, copySkill, integrations, type EngineBinaries } from "./integrations.ts";
import { exportFileName, sessionMarkdown } from "./export-md.ts";
import { Attachments } from "./attachments.ts";
import { imagesNamed, keepImage, withImages } from "./tool-images.ts";
import { ImageGen } from "./imagegen.ts";
import { SessionLinks } from "./links.ts";
import type { AgentBrowser } from "./browse.ts";

export { HttpError };

const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

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
  /** Gateway data folder (document revisions live under it). Defaults to the parent of managedWorksDir. */
  dataDir?: string;
  /** Hangul document engine; without it HWPX/HWP are listed but not opened as text. */
  kordoc?: Kordoc | null;
  /** Word/PowerPoint/Excel engine (the IeumOffice command line tool). */
  ieum?: IeumOffice | null;
  /** The agent browser (browse.ts): one visible window sessions may use. */
  browse?: AgentBrowser | null;
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
};

type PendingCreate = { requestId: string; path: string; target: CreateTarget; sources: { artifactId: string; revision: number }[] };

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

function findOnPath(name: string) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const candidate of [join(dir, name), join(dir, `${name}.exe`)]) if (dir && existsSync(candidate)) return candidate;
  }
  return null;
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
  /** The new document each running request asked for. */
  private readonly creating = new Map<string, PendingCreate>();
  readonly documents: Documents;
  /** "그림": pictures drawn with GPT Image through Codex (imagegen.ts). */
  readonly images: ImageGen;
  /** Linked sessions ("세션 잇기"): replies relayed between sessions in turn (links.ts). */
  readonly links: SessionLinks;
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly options: ManagerOptions;

  constructor(store: Store, bus: EventBus, options: ManagerOptions) {
    this.store = store;
    this.bus = bus;
    this.options = options;
    this.documents = new Documents(store, bus, options.dataDir ?? dirname(options.managedWorksDir), options.kordoc ?? null, options.ieum ?? null);
    this.attachments = new Attachments(options.dataDir ?? dirname(options.managedWorksDir));
    this.images = new ImageGen(
      {
        session: (id) => this.sessions.get(id),
        work: (id) => this.works.get(id),
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
    options.browse?.bind({
      lookup: (sessionId) => {
        const session = this.sessions.get(sessionId);
        const work = session ? this.works.get(session.workId) : undefined;
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
      if (item.kind === "turnEnd") this.afterTurn(sessionId, item.status);
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
      if (wasBusy && patch.status === "idle") this.drainSoon(sessionId);
    },
    providerStatus: (status) => {
      this.bus.publish({ type: "provider.status", status });
    },
    steerDropped: (sessionId, turnKeys) => {
      const lost: Steered[] = [];
      for (const key of turnKeys) {
        const entry = this.steering.get(sessionId)?.get(key);
        if (!entry) continue;
        // Reported while the steer request itself was still on its way: settled when it returns.
        if (!entry.item) entry.dropped = true;
        else lost.push(entry);
      }
      this.requeueDropped(sessionId, lost);
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
  private requeueDropped(sessionId: string, lost: Steered[]) {
    const session = this.sessions.get(sessionId);
    if (!session || !lost.length) return;
    for (const entry of lost) {
      this.steering.get(sessionId)?.delete(entry.requestId);
      if (entry.item) this.sink.upsertItem(sessionId, { ...entry.item, undelivered: true });
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
      text: `멈췄기 때문에 작업 중에 보낸 요청 ${lost.length}개는 전해지지 않았습니다. 입력창 위 목록에서 다시 보내거나 지울 수 있습니다.`,
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
      this.sink.upsertItem(session.id, {
        kind: "notice",
        id: `restart:${Date.now()}`,
        level: "info",
        text: "앱이 다시 시작되어 진행 중이던 응답이 멈췄습니다. 이어서 요청하면 같은 세션에서 계속합니다.",
        at: Date.now(),
      });
      this.saveSession({ ...session, status: "idle", activity: null, updatedAt: Date.now() });
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
      void this.send(sessionId, next.id, next.text, next.refs, null, next.create, "auto", { attachments: next.attachments ?? [], plan: next.plan === true }).catch((error: unknown) => {
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
    return this.send(sessionId, entry.id, entry.text, entry.refs, null, entry.create, entry.plan ? "queue" : "steer", { attachments: entry.attachments ?? [], plan: entry.plan === true });
  }

  snapshot(): Snapshot {
    return {
      protocolVersion: PROTOCOL_VERSION,
      seq: this.bus.currentSeq,
      hostId: this.options.hostId,
      hostLabel: this.options.hostLabel,
      folders: [...this.folders.values()],
      works: [...this.works.values()],
      sessions: [...this.sessions.values()],
      providers: [...this.adapters.values()].map((adapter) => adapter.status()),
      prefs: this.prefs(),
      artifacts: this.documents.list(),
      proposals: this.documents.listProposals(),
      handoffs: [...this.handoffs.values()],
      links: this.links.list(),
      tools: this.tools(),
      ...(this.options.browse ? { browser: this.options.browse.status() } : {}),
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
      kordoc: { available: Boolean(kordoc?.available), version: null, path: kordoc?.runner ?? null, busy: false, message: null },
      ieumoffice: { available: Boolean(ieum?.available), version: this.ieumVersion, path: ieum?.cli ?? null, busy, message: this.ieumBusy?.message ?? null },
      hop: { available: Boolean(hop), version: hop?.version ?? null, path: hop?.launcher ?? null, busy: false, message: null },
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
        this.documents.ieum = new IeumOffice(cli);
        await this.refreshTools();
      })
      .catch((error: unknown) => report({ stage: "error", message: error instanceof Error ? error.message : String(error) }));
    return this.tools();
  }

  private engineBinaries(): EngineBinaries {
    return { claude: this.adapters.get("claude")?.status().binary ?? null, codex: this.adapters.get("codex")?.status().binary ?? null };
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
    if (!source) throw new HttpError(501, "ieumoffice_missing", "이음오피스가 설치되어 있지 않습니다.");
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
    this.saveFolder(next);
    return next;
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
      cwd = join(this.options.managedWorksDir, id);
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
    this.saveWork(work);
    return work;
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
    if (request.provider !== "claude" && request.provider !== "codex") {
      throw new HttpError(400, "invalid_provider", "지원하지 않는 엔진입니다.");
    }
    const now = Date.now();
    const count = [...this.sessions.values()].filter((session) => session.workId === workId).length;
    const session: Session = {
      id: randomUUID(),
      workId,
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
    const listing = patch.pinned !== undefined || patch.sort !== undefined || patch.archived !== undefined || patch.seen !== undefined;
    const content = patch.purpose !== undefined || patch.model !== undefined || patch.effort !== undefined;
    const next = { ...session, updatedAt: content || !listing ? Date.now() : session.updatedAt };
    if (patch.pinned !== undefined) next.pinned = Boolean(patch.pinned);
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
    const work =
      [...this.works.values()].filter((entry) => entry.cwd === history.cwd && !entry.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
      this.createWork({ title: basename(history.cwd) || history.title, cwd: history.cwd });
    const created = this.createSession(work.id, { provider: request.provider, purpose: history.title.slice(0, 60) });
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
    return adapter.commands({ ...session, access: this.accessOf(session) }, this.requireWork(session.workId));
  }

  async compact(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (session.status !== "idle" && session.status !== "error") throw new HttpError(409, "session_busy", "응답이 끝난 뒤에 압축할 수 있습니다.");
    const adapter = this.adapter(session.provider);
    if (!session.nativeSessionId || !adapter.compact) throw new HttpError(409, "nothing_to_compact", "아직 압축할 대화가 없습니다.");
    const work = this.requireWork(session.workId);
    const started = await adapter.compact({ ...session, access: this.accessOf(session) }, work);
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
    const session = this.requireSession(sessionId);
    const attachments = options.attachments ?? [];
    const plan = options.plan === true;
    const relay = options.relay ?? null;
    const trimmed = text.trim() || (attachments.length ? "첨부한 파일을 봐 주세요." : "");
    if (!requestId) throw new HttpError(400, "missing_request_id", "requestId가 필요합니다.");
    if (!trimmed) throw new HttpError(400, "empty_message", "보낼 내용이 없습니다.");
    // Checked up front: a request is never half sent because a file went missing.
    const files = this.attachments.resolve(attachments);
    const fingerprint = hashText(
      refs.length || create || attachments.length
        ? `${trimmed}\u0000${JSON.stringify(refs)}\u0000${JSON.stringify(create)}${attachments.length ? `\u0000${attachments.map((entry) => entry.id).join(",")}` : ""}`
        : trimmed,
    );
    const seen = this.store.findRequest(requestId);
    if (seen) {
      if (seen.sessionId !== sessionId || seen.textHash !== fingerprint) {
        throw new HttpError(409, "request_id_conflict", "같은 requestId로 다른 요청을 보냈습니다.");
      }
      return { duplicate: true, delivery: "turn" };
    }
    if (session.queued.some((entry) => entry.id === requestId)) return { duplicate: true, delivery: "queued" };
    // Anything else sent to a linked session comes from the user: it pauses the link.
    if (!relay) this.links.userInput(sessionId);
    const work = this.requireWork(session.workId);
    // A drawing is a turn of its own: never steered in or kept for later without its instructions.
    if (options.engineText && session.status !== "idle" && session.status !== "error") throw new HttpError(409, "session_busy", "이 세션이 일하는 중입니다. 끝난 뒤에 다시 보내 주세요.");
    if (session.status !== "idle" && session.status !== "error") {
      if (relay) throw new HttpError(409, "session_busy", "받을 세션이 아직 응답 중입니다.");
      // The engine is working. A request steers into the running turn (the engine takes it at its
      // next step) when it can; otherwise it waits and becomes the next turn ("끝나면 보내기").
      const adapter = this.adapter(session.provider);
      // A request to plan first is a turn of its own: it waits for the running one.
      const steerable =
        mode !== "queue" &&
        !plan &&
        Boolean(adapter.steer) &&
        (session.status === "running" || session.status === "starting") &&
        !from &&
        !create &&
        !refs.some((ref) => ref.mode === "edit");
      if (steerable) {
        const pinned: { ref: DocRef; pinned: string; pinnedView: string | null; proposal: Proposal | null }[] = [];
        for (const ref of refs) pinned.push({ ref, ...(await this.documents.prepare(ref, sessionId, requestId, work.cwd)) });
        const entry: Steered = { requestId, text: trimmed, refs, attachments, item: null, dropped: false };
        const steering = this.steering.get(sessionId) ?? new Map<string, Steered>();
        this.steering.set(sessionId, steering.set(requestId, entry));
        const steered = await adapter.steer!(session, work, this.engineText(trimmed, pinned, work.cwd, null), requestId, files).catch(() => false);
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
        };
        this.saveSession({ ...current, queued: [...current.queued, waiting] });
        return { duplicate: false, delivery: "queued" };
      }
      // The turn ended meanwhile: this request starts the next one.
    }
    this.steering.delete(sessionId);
    // A plan still waiting for the go-ahead is passed over by a new request.
    this.expirePlans(sessionId);
    // Pin each document: the engine reads exactly this revision; edits go to a working copy.
    const prepared: { ref: DocRef; pinned: string; pinnedView: string | null; proposal: Proposal | null }[] = [];
    for (const ref of refs) prepared.push({ ref, ...(await this.documents.prepare(ref, sessionId, requestId, work.cwd)) });
    // A new document: a free name in the work folder now, tracked with its sources after the turn.
    let created: PendingCreate | null = null;
    if (create) {
      mkdirSync(work.cwd, { recursive: true });
      const path = reservePath(work.cwd, create);
      created = { requestId, path, target: create, sources: refs.map((ref) => ({ artifactId: ref.artifactId, revision: ref.revision })) };
      this.creating.set(sessionId, created);
    }
    this.store.saveRequest(requestId, sessionId, fingerprint);
    const engineText = options.engineText ?? (relay ? `${relay.header}\n\n${trimmed}` : this.engineText(trimmed, prepared, work.cwd, from, created));
    this.sink.upsertItem(sessionId, {
      kind: "user",
      id: `user:${requestId}`,
      text: trimmed,
      at: Date.now(),
      ...(plan ? { plan: true } : {}),
      ...(refs.length ? { refs: refs.map((ref) => this.documents.summary(ref)) } : {}),
      ...(from ? { from } : {}),
      ...(created ? { create: { format: created.target.format, name: basename(created.path), path: created.path } } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(options.draw ? { draw: options.draw } : {}),
      ...(relay ? { link: relay.hop } : {}),
    });
    this.turnStarted.set(sessionId, Date.now());
    if (plan) this.planning.set(sessionId, requestId);
    else this.planning.delete(sessionId);
    this.sink.updateSession(sessionId, { status: "starting", activity: plan ? "계획 세우는 중" : "응답 준비 중", lastError: null });
    // A relayed message does not switch the conversation on screen (it goes back and forth), nor
    // does a drawing made for another conversation.
    this.saveWork({ ...work, activeSessionId: options.activate === false || relay ? work.activeSessionId : sessionId, updatedAt: Date.now() });
    try {
      const current = this.requireSession(sessionId);
      await this.adapter(session.provider).send({ ...current, access: this.accessOf(current), plan }, work, engineText, requestId, files);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const entry of prepared) if (entry.proposal) this.documents.discardProposal(entry.proposal.id);
      if (created) this.creating.delete(sessionId);
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
  ) {
    const parts: string[] = [];
    if (from) parts.push(`[다른 세션에서 온 요청] 보낸 곳: ${from.label}. 이 대화에 답하면 보낸 곳으로 전달됩니다.`);
    if (prepared.length) {
      parts.push("[Achmage Workbench] 이 요청에는 문서가 고정된 판으로 첨부되어 있습니다.");
      for (const entry of prepared) parts.push(this.documents.promptFor(entry.ref, entry.pinned, entry.proposal, cwd, entry.pinnedView));
    }
    if (created) parts.push(createGuide(created.target, created.path, cwd, { ieum: this.documents.ieum, kordoc: this.documents.kordoc }));
    if (!parts.length) return text;
    return `${parts.join("\n")}\n\n요청:\n${text}`;
  }

  /** Open a file of the work folder (or any path the user picked) as a tracked document. */
  openFile(workId: string, rawPath: string) {
    const work = this.requireWork(workId);
    if (!rawPath.trim()) throw new HttpError(400, "missing_path", "파일 경로가 필요합니다.");
    const path = isAbsolute(rawPath) ? rawPath : resolve(work.cwd, rawPath);
    if (!existsSync(path)) throw new HttpError(404, "file_missing", "파일이 없습니다.");
    if (!formatOf(path)) throw new HttpError(415, "unsupported_format", "Markdown·HTML·PDF·한글(HWPX·HWP)·워드·PPT·엑셀·텍스트·디자인(.design.json)만 열 수 있습니다.");
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
  createPage(workId: string, name: string) {
    const work = this.requireWork(workId);
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
  createDesign(workId: string, name: string, preset: DesignPreset, text: string | null = null) {
    const work = this.requireWork(workId);
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
    const cli = findOnPath("pdfcraft-cli");
    if (!cli) throw new HttpError(501, "pdfcraft_missing", "PDFCraft(pdfcraft-cli)가 설치되어 있지 않아 PDF를 편집할 수 없습니다.");
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
  private finishCreate(sessionId: string, status: "completed" | "interrupted" | "failed") {
    const created = this.creating.get(sessionId);
    if (!created) return;
    this.creating.delete(sessionId);
    const session = this.sessions.get(sessionId);
    const work = session ? this.works.get(session.workId) : undefined;
    if (!work) return;
    const name = basename(created.path);
    if (!existsSync(created.path)) {
      if (status === "completed") {
        this.sink.upsertItem(sessionId, { kind: "notice", id: `create-missing:${created.requestId}`, level: "error", text: `새 문서 ${name}이(가) 만들어지지 않았습니다.`, at: Date.now() });
      }
      return;
    }
    const sources = created.sources.map((source) => this.documents.list().find((artifact) => artifact.id === source.artifactId)?.name).filter(Boolean);
    const note = sources.length ? `새 문서 · ${sources.join(", ")}에서` : "새 문서";
    const tracked = this.documents.track(work.id, work.cwd, created.path, "engine", sessionId, note, created.sources);
    if (tracked) {
      this.sink.upsertItem(sessionId, {
        kind: "artifact",
        id: `artifact:create:${created.requestId}`,
        artifactId: tracked.artifact.id,
        revision: tracked.artifact.revision,
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
  private trackChangedFiles(sessionId: string) {
    const started = this.turnStarted.get(sessionId);
    this.turnStarted.delete(sessionId);
    const session = this.sessions.get(sessionId);
    const work = session ? this.works.get(session.workId) : undefined;
    if (!started || !work || !existsSync(work.cwd)) return;
    const changed = recentDocuments(work.cwd, started - 2000);
    if (changed.length) this.trackFiles(sessionId, `scan:${started}`, changed);
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
      const work = session ? this.works.get(session.workId) : undefined;
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

  private trackFiles(sessionId: string, itemId: string, paths: string[]) {
    const session = this.sessions.get(sessionId);
    const work = session ? this.works.get(session.workId) : undefined;
    if (!session || !work) return;
    for (const path of paths) {
      if (isWorkbenchPath(path)) continue;
      try {
        const tracked = this.documents.track(work.id, work.cwd, path, "engine", sessionId, null);
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

  private afterTurn(sessionId: string, status: "completed" | "interrupted" | "failed") {
    this.planEnded(sessionId, status);
    // After a stop or a failure the waiting requests stay until the user sends them.
    const waiting = status === "completed" ? 0 : this.holdQueued(sessionId);
    if (waiting) {
      this.sink.upsertItem(sessionId, {
        kind: "notice",
        id: `queue-held:${Date.now()}`,
        level: "info",
        text: `${status === "interrupted" ? "멈췄기 때문에" : "응답이 끝나지 못해서"} 보낼 예정인 요청 ${waiting}개를 보내지 않았습니다. 입력창 위에서 보내거나 지울 수 있습니다.`,
        at: Date.now(),
      });
    }
    this.finishCreate(sessionId, status);
    this.images.afterTurn(sessionId, status);
    this.trackChangedFiles(sessionId);
    for (const running of this.documents.runningProposals(sessionId)) {
      const proposal = status === "completed" ? this.documents.finishProposal(running.id) : this.documents.discardProposal(running.id);
      if (proposal.status === "pending") {
        this.sink.upsertItem(sessionId, { kind: "proposal", id: `proposal:${proposal.id}`, proposalId: proposal.id, at: Date.now() });
      } else if (proposal.status === "empty") {
        const name = this.documents.get(proposal.artifactId).name;
        this.sink.upsertItem(sessionId, { kind: "notice", id: `proposal-empty:${proposal.id}`, level: "info", text: `${name}: 작업 사본이 바뀌지 않아 수정안이 없습니다.`, at: Date.now() });
      }
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
      const answered: Handoff =
        status === "completed"
          ? { ...handoff, status: "answered", reply: reply || null, answeredAt: Date.now() }
          : { ...handoff, status: "failed", reply: reply || null, error: status === "interrupted" ? "중단됨" : "응답이 끝나지 못했습니다", answeredAt: Date.now() };
      this.saveHandoff(answered);
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
   * Search titles' conversations and documents by the words typed (all must appear, any case).
   * Local index only: no model is asked. Archived things are left out unless asked for.
   */
  search(query: string, options: { archived?: boolean; provider?: Provider | null; folderId?: string | null } = {}): SearchResult {
    const started = performance.now();
    // Words must all appear; "quoted words" must appear together as typed.
    const terms = [...query.trim().matchAll(/"([^"]+)"|(\S+)/g)]
      .map((match) => (match[1] ?? match[2] ?? "").trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((term) => term.slice(0, 100));
    const result: SearchResult = { query, sessions: [], documents: [], tookMs: 0 };
    if (!terms.length) return result;
    const inFolder = (workId: string) => {
      if (!options.folderId) return true;
      for (let at = this.works.get(workId)?.folderId ?? null; at; at = this.folders.get(at)?.parentId ?? null) if (at === options.folderId) return true;
      return false;
    };
    const bySession = new Map<string, { sessionId: string; workId: string; total: number; hits: SearchHit[] }>();
    for (const hit of this.store.searchItems(terms, 800)) {
      const session = this.sessions.get(hit.sessionId);
      if (!session) continue;
      if (!options.archived && this.hidden(session.workId, session.id)) continue;
      if (options.provider && session.provider !== options.provider) continue;
      if (!inFolder(session.workId)) continue;
      let entry = bySession.get(session.id);
      if (!entry) {
        if (bySession.size >= 40) continue;
        entry = { sessionId: session.id, workId: session.workId, total: 0, hits: [] };
        bySession.set(session.id, entry);
      }
      entry.total += 1;
      if (entry.hits.length < 3) entry.hits.push({ sessionId: session.id, itemId: hit.itemId, kind: hit.kind, at: hit.at, ...snippetOf(hit.text, terms) });
    }
    result.sessions = [...bySession.values()];
    for (const hit of this.store.searchDocuments(terms, 60)) {
      let artifact;
      try {
        artifact = this.documents.get(hit.artifactId);
      } catch {
        continue;
      }
      if (!options.archived && this.hidden(artifact.workId)) continue;
      if (!inFolder(artifact.workId)) continue;
      result.documents.push({ artifactId: artifact.id, workId: artifact.workId, ...snippetOf(hit.text, terms) });
      if (result.documents.length >= 20) break;
    }
    result.tookMs = Math.round(performance.now() - started);
    return result;
  }

  /**
   * "마크다운으로 내보내기": the conversation by fixed rules (see export-md.ts). In the work folder it
   * goes to "세션 기록/" and becomes a document of the work (opened, attached, searched like others);
   * a later export of the same conversation updates the same file.
   */
  exportMarkdown(sessionId: string, request: ExportMarkdownRequest): ExportMarkdownResult {
    const session = this.requireSession(sessionId);
    const work = this.requireWork(session.workId);
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

  async refreshProviders(): Promise<ProviderStatus[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.refreshStatus()));
  }

  /** Stop watching documents opened in other apps. */
  stopExternalWatches() {
    for (const stop of [...this.external.values()]) stop();
  }

  async shutdown() {
    this.stopExternalWatches();
    this.flush();
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.shutdown()));
    await this.options.browse?.shutdown();
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

  private requireWork(workId: string) {
    const work = this.works.get(workId);
    if (!work) throw new HttpError(404, "work_not_found", "작업을 찾지 못했습니다.");
    return work;
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "session_not_found", "세션을 찾지 못했습니다.");
    return session;
  }
}
