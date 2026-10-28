import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  PROTOCOL_VERSION,
  applyItemEvent,
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
  type Handoff,
  type HandoffRequest,
  type Proposal,
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

export { HttpError };

const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

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
};

const DEFAULT_PURPOSE = /^대화 \d+$/;

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

function plain(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~|]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

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
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly options: ManagerOptions;

  constructor(store: Store, bus: EventBus, options: ManagerOptions) {
    this.store = store;
    this.bus = bus;
    this.options = options;
    this.documents = new Documents(store, bus, options.dataDir ?? dirname(options.managedWorksDir), options.kordoc ?? null, options.ieum ?? null);
    for (const handoff of store.handoffs()) this.handoffs.set(handoff.id, handoff);
    for (const folder of store.folders()) this.folders.set(folder.id, folder);
    for (const work of store.works()) this.works.set(work.id, { ...work, titleSource: work.titleSource ?? "auto" });
    // Rows written by older versions may lack newer fields.
    for (const session of store.sessions()) this.sessions.set(session.id, {
        ...session,
        effort: session.effort ?? null,
        engineModel: session.engineModel ?? null,
        engineEffort: session.engineEffort ?? null,
        preview: session.preview ?? null,
        previewAt: session.previewAt ?? null,
        purposeSource: session.purposeSource ?? (DEFAULT_PURPOSE.test(session.purpose) ? "auto" : "user"),
      });
    this.backfillOverview();
    this.recoverAfterRestart();
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
    upsertItem: (sessionId, item) => {
      if (item.kind === "turnEnd") {
        this.finishStreaming(sessionId);
      }
      const items = this.loadItems(sessionId);
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
    delta: (sessionId, itemId, textDelta) => {
      const items = this.loadItems(sessionId);
      this.transcripts.set(sessionId, applyItemEvent(items, { type: "item.delta", sessionId, itemId, textDelta }));
      this.markDirty(sessionId, itemId);
      this.bus.publish({ type: "item.delta", sessionId, itemId, textDelta });
    },
    updateSession: (sessionId, patch) => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.saveSession({ ...session, ...patch, updatedAt: Date.now() });
    },
    providerStatus: (status) => {
      this.bus.publish({ type: "provider.status", status });
    },
  };

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
      tools: this.tools(),
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
    const folder: Folder = { id: randomUUID(), parentId, name: trimmed, sort: siblings.length };
    this.folders.set(folder.id, folder);
    this.store.saveFolder(folder);
    this.bus.publish({ type: "folder.upserted", folder });
    return folder;
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
    const work: Work = { id, title, titleSource: request.titleSource ?? "auto", folderId, cwd, cwdManaged, activeSessionId: null, createdAt: now, updatedAt: now };
    this.saveWork(work);
    return work;
  }

  updateWork(workId: string, patch: Partial<Pick<Work, "title" | "folderId" | "activeSessionId">>): Work {
    const work = this.requireWork(workId);
    if (patch.activeSessionId && this.sessions.get(patch.activeSessionId)?.workId !== workId) {
      throw new HttpError(400, "invalid_session", "다른 작업의 세션입니다.");
    }
    const next: Work = { ...work, ...patch, updatedAt: Date.now() };
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

  createSession(workId: string, request: CreateSessionRequest): Session {
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
      createdAt: now,
      updatedAt: now,
    };
    this.saveSession(session);
    this.saveWork({ ...work, activeSessionId: session.id, updatedAt: now });
    return session;
  }

  /** Rename, or pick the model / effort used from the next turn on. */
  updateSession(sessionId: string, patch: UpdateSessionRequest): Session {
    const session = this.requireSession(sessionId);
    const next = { ...session, updatedAt: Date.now() };
    if (patch.purpose !== undefined) {
      // A name typed by hand stays; clearing it hands the name back to the automatic title.
      const trimmed = patch.purpose.trim();
      next.purpose = trimmed ? trimmed.slice(0, 60) : session.purpose;
      next.purposeSource = trimmed ? "user" : "auto";
    }
    if (patch.model !== undefined) next.model = patch.model || null;
    if (patch.effort !== undefined) next.effort = patch.effort || null;
    this.saveSession(next);
    if (patch.purpose !== undefined && next.purposeSource === "auto") this.retitle(sessionId, true);
    return this.requireSession(sessionId);
  }

  async send(
    sessionId: string,
    requestId: string,
    text: string,
    refs: DocRef[] = [],
    from: { sessionId: string; label: string } | null = null,
    create: CreateTarget | null = null,
  ): Promise<{ duplicate: boolean }> {
    const session = this.requireSession(sessionId);
    const trimmed = text.trim();
    if (!requestId) throw new HttpError(400, "missing_request_id", "requestId가 필요합니다.");
    if (!trimmed) throw new HttpError(400, "empty_message", "보낼 내용이 없습니다.");
    const fingerprint = hashText(refs.length || create ? `${trimmed}\u0000${JSON.stringify(refs)}\u0000${JSON.stringify(create)}` : trimmed);
    const seen = this.store.findRequest(requestId);
    if (seen) {
      if (seen.sessionId !== sessionId || seen.textHash !== fingerprint) {
        throw new HttpError(409, "request_id_conflict", "같은 requestId로 다른 요청을 보냈습니다.");
      }
      return { duplicate: true };
    }
    if (session.status !== "idle" && session.status !== "error") {
      throw new HttpError(409, "session_busy", "이 세션은 아직 응답 중입니다.");
    }
    const work = this.requireWork(session.workId);
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
    const engineText = this.engineText(trimmed, prepared, work.cwd, from, created);
    this.sink.upsertItem(sessionId, {
      kind: "user",
      id: `user:${requestId}`,
      text: trimmed,
      at: Date.now(),
      ...(refs.length ? { refs: refs.map((ref) => this.documents.summary(ref)) } : {}),
      ...(from ? { from } : {}),
      ...(created ? { create: { format: created.target.format, name: basename(created.path), path: created.path } } : {}),
    });
    this.turnStarted.set(sessionId, Date.now());
    this.sink.updateSession(sessionId, { status: "starting", activity: "응답 준비 중", lastError: null });
    this.saveWork({ ...work, activeSessionId: sessionId, updatedAt: Date.now() });
    try {
      await this.adapter(session.provider).send(this.requireSession(sessionId), work, engineText, requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const entry of prepared) if (entry.proposal) this.documents.discardProposal(entry.proposal.id);
      if (created) this.creating.delete(sessionId);
      this.sink.upsertItem(sessionId, { kind: "notice", id: `error:${requestId}`, level: "error", text: `보내지 못했습니다: ${message}`, at: Date.now() });
      this.sink.updateSession(sessionId, { status: "error", activity: null, lastError: message });
    }
    return { duplicate: false };
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
  private afterTurn(sessionId: string, status: "completed" | "interrupted" | "failed") {
    this.finishCreate(sessionId, status);
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
      await this.send(target.id, request.requestId, request.text, refs, {
        sessionId: source.id,
        label: `${sourceWork.title} · ${source.purpose} (${source.provider === "claude" ? "Claude" : "Codex"})`,
      });
    } catch (error) {
      this.saveHandoff({ ...handoff, status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return this.handoffs.get(handoff.id)!;
  }

  async interrupt(sessionId: string) {
    const session = this.requireSession(sessionId);
    await this.adapter(session.provider).interrupt(session);
  }

  async answerApproval(sessionId: string, itemId: string, decision: ApprovalDecision) {
    const session = this.requireSession(sessionId);
    if (decision !== "accept" && decision !== "decline") {
      throw new HttpError(400, "invalid_decision", "accept 또는 decline만 가능합니다.");
    }
    const handled = await this.adapter(session.provider).answerApproval(session, itemId, decision);
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

  /** Requests of the given sessions, oldest first. */
  private requestsOf(sessionIds: string[]) {
    return sessionIds
      .flatMap((id) => this.loadItems(id).flatMap((item) => (item.kind === "user" ? [{ at: item.at, text: item.text }] : [])))
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
