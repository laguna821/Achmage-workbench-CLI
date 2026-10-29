import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  PROVIDER_LABEL,
  parseViewQuery,
  type InsightDraft,
  type Artifact,
  type CardList,
  type PageTemplate,
  type PkmCard,
  type PkmRule,
  type PkmScope,
  type PkmState,
  type PkmView,
  type RuleChange,
  type RulePlacement,
  type Session,
  type VaultNote,
  type Work,
} from "@workbench/contracts";
import { WORKBENCH_DIR } from "./artifacts.ts";
import type { EventBus } from "./bus.ts";
import { HttpError } from "./errors.ts";
import { excerptOf, firstImage, noteDate, noteTags, parseFrontmatter, splitFrontmatter, valuesOf } from "./frontmatter.ts";
import type { SessionManager } from "./sessions.ts";
import type { Store } from "./store.ts";
import { IMAGE_EXTENSIONS, VaultMirror, noteTitle } from "./vault.ts";
import { VaultNotes, stageOf } from "./vault-notes.ts";
import { fillTemplate, localStamp, readTemplates, templateChoices, templateFile, yamlValue, type TemplateSource } from "./pages.ts";
import { exportFileName, headingOf, tidyMessage } from "./export-md.ts";
import { filterItems, groupItems, kindsFor, sessionStatuses, workEngines, workStatuses, type ViewItem } from "./pkm-views.ts";
import { cleanRules, placementFor } from "./pkm-rules.ts";
import { claudeWriteGuard, codexSandbox, contextCard, type CardProject } from "./pkm-guard.ts";
import type { ClaudeLaunch, CodexLaunch } from "./providers/types.ts";
import { checkInsight, insightDraft, insightTemplate, publishRequest } from "./insight.ts";
import type { FrontmatterValue } from "./frontmatter.ts";

// The PKM layer of the gateway (design 워크스테이션-다음설계 §4): the read-only vault mirror and,
// on top of it, what ties notes to works and sessions. Small state lives in the meta table under
// `pkm.*` keys; every change is announced as one `pkm.changed` event so screens fetch it again.

export type PkmOptions = {
  vaultDebounceMs?: number;
  /** Gateway data folder: app-wide page templates live in `templates/` under it. */
  dataDir?: string;
};

/** The vault's own template folder (read only), as the user's vault keeps it. */
export const VAULT_TEMPLATES = "90. Settings/91. Templates";

/** A file name from a page title: no path characters, at most 80 characters. */
const safeStem = (name: string, fallback: string) => (name.trim() || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.md$/i, "").replace(/\s+/g, " ").slice(0, 80).trim() || fallback;

/** What the centre can list as cards. */
export type CardTarget = { kind: "vault"; path: string; descendants: boolean } | { kind: "folder"; id: string } | { kind: "work"; id: string } | { kind: "view"; id: string };

/** Views a first start offers (they can be changed or removed like any other). */
const DEFAULT_VIEWS: PkmView[] = [
  { id: "view-notes-week", name: "이번 주 노트", query: "kind:note @last7d", groupBy: "DIKM_단계:" },
  { id: "view-running", name: "진행 중인 세션", query: "kind:session status:running", groupBy: null },
];

const CARD_LIMIT = 500;

const sha8 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex").slice(0, 8);

function readHead(path: string, bytes = 48 * 1024) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString("utf8").replace(/�+$/, "");
  } finally {
    closeSync(fd);
  }
}

export class Pkm {
  readonly vault: VaultMirror;
  readonly notes: VaultNotes;
  protected readonly store: Store;
  protected readonly bus: EventBus;
  readonly manager: SessionManager;
  protected readonly options: PkmOptions;

  constructor(store: Store, bus: EventBus, manager: SessionManager, options: PkmOptions = {}) {
    this.store = store;
    this.bus = bus;
    this.manager = manager;
    this.options = options;
    this.vault = new VaultMirror((version) => this.publish("vault", version), { debounceMs: options.vaultDebounceMs });
    this.notes = new VaultNotes(this.vault);
    const saved = store.getMeta("pkm.vault");
    if (saved) this.vault.restore(saved);
    manager.noteHook = (notes, cwd, sessionId) => this.notesForSend(notes, cwd, sessionId);
    // Rules place new works once their engine or first document is known (never inside the event itself).
    bus.subscribe((event) => {
      if (event.type === "session.upserted") this.schedulePlacement(event.session.workId);
      else if (event.type === "artifact.upserted") this.schedulePlacement(event.artifact.workId);
    });
  }

  protected publish(scope: PkmScope, version = Date.now()) {
    this.bus.publish({ type: "pkm.changed", scope, version });
  }

  protected readJson<T>(key: string, fallback: T): T {
    try {
      const raw = this.store.getMeta(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  protected writeJson(key: string, value: unknown) {
    this.store.setMeta(key, JSON.stringify(value));
  }

  state(): PkmState {
    return { vault: this.vault.status(), views: this.viewsWithCounts(), rules: this.rules(), placements: this.placements(), pins: this.readJson<Record<string, string[]>>("pkm.pins", {}) };
  }

  /** Attach a vault folder (or none). Only the path is remembered; the vault itself is never written. */
  attachVault(path: string | null) {
    const wanted = path?.trim() || null;
    try {
      this.vault.attach(wanted);
    } catch (error) {
      throw new HttpError(400, "invalid_vault", error instanceof Error ? error.message : String(error));
    }
    this.store.setMeta("pkm.vault", this.vault.root ?? "");
    return this.vault.status();
  }

  // ── notes pinned to a work, the context card and the write guard ─────────────────────────

  pins(workId: string): string[] {
    return this.readJson<Record<string, string[]>>("pkm.pins", {})[workId] ?? [];
  }

  /** Pin a vault note to a work (its sessions get the note's path in their context card), or unpin it. */
  setPin(workId: string, path: string, pinned: boolean) {
    this.requireWork(workId);
    if (pinned && !this.vault.current?.notes.has(path)) throw new HttpError(404, "note_missing", "볼트에 그 노트가 없습니다.");
    const all = this.readJson<Record<string, string[]>>("pkm.pins", {});
    const list = (all[workId] ?? []).filter((entry) => entry !== path);
    all[workId] = pinned ? [...list, path] : list;
    this.writeJson("pkm.pins", all);
    this.publish("pins");
    return all[workId];
  }

  /** Paths the engines must not write: the vault as attached, and where it really is. */
  protectedRoots(): string[] {
    const root = this.vault.root;
    if (!root) return [];
    try {
      return [...new Set([root, realpathSync(root)])];
    } catch {
      return [root];
    }
  }

  /** The project part of the card (project.ts sets it). */
  projectCard: ((work: Work) => CardProject) | null = null;
  /** The engines' search tool's usage line, once it exists. */
  findInstructions: (() => string | null) | null = null;

  /** The context card of a new session of this work (≤ 2 KB): the work, its project note, the vault rule, the pinned notes. */
  cardFor(work: Work) {
    const root = this.vault.root;
    const navigator = root ? this.vault.navigator : null;
    return contextCard({
      title: work.title,
      folders: this.folderTrail(work.folderId),
      cwd: work.cwd,
      vault: root,
      pinned: root ? this.pins(work.id).map((path) => join(root, path)) : [],
      project: this.projectCard?.(work) ?? null,
      hidden: navigator ? [...navigator.hiddenFolders, ...navigator.hiddenFileNames] : [],
      find: this.findInstructions?.() ?? null,
    });
  }

  /** What a new Claude process gets: the card as `systemPrompt.append`, and the PreToolUse guard. */
  readonly claudeLaunch: ClaudeLaunch = (_session, work) => {
    const roots = this.protectedRoots();
    return { append: this.cardFor(work), hooks: roots.length ? { PreToolUse: [claudeWriteGuard(roots)] } : null };
  };

  /** What a new Codex thread gets: the card as `developerInstructions`, and a sandbox that leaves the vault out. */
  readonly codexLaunch: CodexLaunch = (session, work) => {
    const sandbox = codexSandbox(session.access, work.cwd, this.protectedRoots());
    return { instructions: this.cardFor(work), readOnly: sandbox.mode === "read-only", excludeTmp: sandbox.excludeTmp };
  };

  // ── which sessions read which note ─────────────────────────────────────────────────────

  private noteReads(): Record<string, string[]> {
    return this.readJson<Record<string, string[]>>("pkm.noteReads", {});
  }

  private sessionsOf(path: string) {
    return this.noteReads()[path]?.length ?? 0;
  }

  /**
   * Notes attached to a request: each is copied as it is now into the work folder (read-only,
   * `.workbench/notes/`), and the engine is told where the copy and the original are and that the
   * vault is not to be changed. The notes remember which sessions read them.
   */
  notesForSend(paths: string[], cwd: string, sessionId: string) {
    const index = this.vault.current;
    const root = this.vault.root;
    if (!index || !root) throw new HttpError(409, "no_vault", "연결된 볼트가 없어 노트를 붙일 수 없습니다.");
    const refs: { path: string; title: string }[] = [];
    const lines = ["[볼트 노트 · 읽기 전용] 이 요청에 옵시디언 볼트의 노트가 참고 자료로 붙어 있습니다. 읽고 답하되, 노트를 고치거나 볼트에 파일을 만들지 마세요(사람 원본입니다)."];
    const folder = join(cwd, WORKBENCH_DIR, "notes");
    for (const path of [...new Set(paths)]) {
      const entry = index.notes.get(path);
      if (!entry || entry.ext !== ".md") throw new HttpError(404, "note_missing", `볼트에 그 노트가 없습니다: ${path}`);
      const absolute = this.vault.resolve(path);
      const data = readFileSync(absolute);
      const title = this.notes.meta(entry).title;
      mkdirSync(folder, { recursive: true });
      const copy = join(folder, `${noteTitle(path).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.${sha8(data)}.md`);
      if (!existsSync(copy)) {
        writeFileSync(copy, data);
        chmodSync(copy, 0o444);
      }
      refs.push({ path, title });
      lines.push(`- 「${title}」 (${path})`, `  · 지금 내용의 읽기 전용 사본: ${relative(cwd, copy)}`, `  · 볼트 원본(쓰지 마세요): ${absolute}`);
    }
    const reads = this.noteReads();
    for (const ref of refs) reads[ref.path] = [...new Set([...(reads[ref.path] ?? []), sessionId])];
    this.writeJson("pkm.noteReads", reads);
    return { prompt: lines.join("\n"), refs };
  }

  // ── cards ────────────────────────────────────────────────────────────────────────────────

  cards(target: CardTarget): CardList {
    if (target.kind === "vault") return this.vaultCards(target.path, target.descendants);
    if (target.kind === "folder") return this.folderCards(target.id);
    if (target.kind === "view") {
      const view = this.views().find((entry) => entry.id === target.id);
      if (!view) throw new HttpError(404, "view_missing", "그 보기가 없습니다.");
      return this.viewCards(view);
    }
    return this.workCards(target.id);
  }

  private vaultCards(path: string, descendants: boolean): CardList {
    const index = this.vault.current;
    if (!index) throw new HttpError(409, "no_vault", "연결된 볼트가 없습니다.");
    const folder = index.folders.get(path);
    if (!folder || (path && index.hidden.has(path))) throw new HttpError(404, "folder_missing", "볼트에 그 폴더가 없습니다.");
    const paths: string[] = [];
    const walk = (at: string) => {
      const entry = index.folders.get(at);
      if (!entry || (at && index.hidden.has(at))) return;
      paths.push(...entry.notes);
      if (descendants) for (const child of entry.children) walk(child);
    };
    walk(path);
    const pinned = new Set(this.vault.navigator?.pinned ?? []);
    const reads = this.noteReads();
    const cards = paths.map((note) => this.notes.card(index.notes.get(note)!, pinned.has(note), reads[note]?.length ?? 0));
    cards.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.date ?? 0) - (a.date ?? 0) || a.title.localeCompare(b.title, "ko"));
    return {
      title: path ? path.split("/").pop()! : (this.vault.status().name ?? "볼트"),
      crumbs: ["볼트", ...(path ? path.split("/") : [])],
      cards: cards.slice(0, CARD_LIMIT),
      total: cards.length,
      descendants,
    };
  }

  private folderTrail(folderId: string | null) {
    const { folders } = this.manager.view;
    const names: string[] = [];
    for (let at = folderId; at; at = folders.get(at)?.parentId ?? null) names.unshift(folders.get(at)?.name ?? "");
    return names.filter(Boolean);
  }

  private workCard(work: Work): PkmCard {
    const sessions = [...this.manager.view.sessions.values()].filter((session) => session.workId === work.id && !session.archivedAt);
    const latest = [...sessions].sort((a, b) => (b.previewAt ?? b.updatedAt) - (a.previewAt ?? a.updatedAt))[0];
    return {
      kind: "work",
      id: work.id,
      title: work.title,
      excerpt: latest?.preview ?? "",
      tags: [],
      date: Math.max(work.updatedAt, ...sessions.map((session) => session.previewAt ?? session.updatedAt)),
      dateKind: "activity",
      thumb: null,
      pinned: work.pinned,
      stage: null,
      provider: latest?.provider,
      status: sessions.find((session) => session.status !== "idle")?.status ?? latest?.status,
      workId: work.id,
      sessions: sessions.length,
      where: this.folderTrail(work.folderId).join(" / "),
    };
  }

  private folderCards(folderId: string): CardList {
    const { folders, works } = this.manager.view;
    const folder = folders.get(folderId);
    if (!folder) throw new HttpError(404, "folder_not_found", "폴더가 없습니다.");
    const inside = (id: string | null): boolean => {
      for (let at = id; at; at = folders.get(at)?.parentId ?? null) {
        if (folders.get(at)?.archivedAt) return false;
        if (at === folderId) return true;
      }
      return false;
    };
    const cards = [...works.values()].filter((work) => !work.archivedAt && inside(work.folderId)).map((work) => this.workCard(work));
    cards.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.date ?? 0) - (a.date ?? 0));
    return { title: folder.name, crumbs: ["작업 공간", ...this.folderTrail(folderId)], cards: cards.slice(0, CARD_LIMIT), total: cards.length };
  }

  private sessionCard(session: Session, work: Work): PkmCard {
    return {
      kind: "session",
      id: session.id,
      title: session.purpose,
      excerpt: session.preview ?? "",
      tags: [],
      date: session.previewAt ?? session.updatedAt,
      dateKind: "activity",
      thumb: null,
      pinned: session.pinned,
      stage: null,
      provider: session.provider,
      status: session.status,
      workId: work.id,
      where: `${work.title} · ${PROVIDER_LABEL[session.provider]}`,
    };
  }

  private workCards(workId: string): CardList {
    const { works, sessions } = this.manager.view;
    const work = works.get(workId);
    if (!work) throw new HttpError(404, "work_not_found", "작업을 찾지 못했습니다.");
    const cards: PkmCard[] = [...sessions.values()].filter((session) => session.workId === workId && !session.archivedAt).map((session) => this.sessionCard(session, work));
    // The project's own note belongs to its project page, not among its pages.
    for (const artifact of this.manager.documents.list().filter((entry) => entry.workId === workId && entry.role !== "project-note")) cards.push(this.pageItem(artifact, work).card);
    // Notes pinned to the work come first (their paths are in its sessions' context card).
    const index = this.vault.current;
    const reads = this.noteReads();
    for (const path of this.pins(workId)) {
      const entry = index?.notes.get(path);
      if (entry) cards.push({ ...this.notes.card(entry, true, reads[path]?.length ?? 0), where: `고정한 노트 · ${entry.path}` });
    }
    cards.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.date ?? 0) - (a.date ?? 0));
    return { title: work.title, crumbs: ["작업 공간", ...this.folderTrail(work.folderId), work.title], cards: cards.slice(0, CARD_LIMIT), total: cards.length };
  }

  private readonly pageCache = new Map<string, { key: string; item: { card: PkmCard; properties: [string, FrontmatterValue][] } }>();

  /** A document of a work as a card, with its front matter (Markdown pages are read once per revision). */
  private pageItem(artifact: Artifact, work: Work): { card: PkmCard; properties: [string, FrontmatterValue][] } {
    const key = `${artifact.revision}:${artifact.updatedAt}:${work.cwd}`;
    const cached = this.pageCache.get(artifact.id);
    if (cached?.key === key) return cached.item;
    let excerpt = "";
    let tags: string[] = [];
    let thumb: PkmCard["thumb"] = null;
    let stage: string | null = null;
    let title = artifact.name;
    let date = artifact.updatedAt;
    let dateKind: PkmCard["dateKind"] = "modified";
    let properties: [string, FrontmatterValue][] = [];
    if (artifact.format === "markdown" || artifact.format === "text") {
      try {
        const { yaml, body } = splitFrontmatter(readHead(this.manager.documents.revisionPath(artifact.id, artifact.revision)));
        properties = parseFrontmatter(yaml);
        excerpt = excerptOf(body);
        tags = noteTags(properties, body);
        stage = stageOf(properties);
        title = valuesOf(properties, "title")[0]?.trim() || artifact.name.replace(/\.(md|markdown|txt)$/i, "");
        const created = noteDate(valuesOf(properties, "date created")[0]);
        if (created) {
          date = created;
          dateKind = "created";
        }
        const image = firstImage(body);
        if (image?.kind === "link") thumb = { page: artifact.id, src: image.target };
        else if (image?.kind === "url") thumb = { url: image.target };
      } catch {
        // A revision that cannot be read now is listed by its name.
      }
    }
    const item = { card: { kind: "page" as const, id: artifact.id, title, excerpt, tags, date, dateKind, thumb, pinned: false, stage, format: artifact.format, workId: work.id, where: relative(work.cwd, artifact.path) }, properties };
    this.pageCache.set(artifact.id, { key, item });
    return item;
  }

  // ── saved views ──────────────────────────────────────────────────────────────────────────

  views(): PkmView[] {
    const raw = this.store.getMeta("pkm.views");
    return raw === null ? DEFAULT_VIEWS : this.readJson<PkmView[]>("pkm.views", []);
  }

  private viewsWithCounts() {
    return this.views().map((view) => {
      try {
        return { ...view, count: this.viewCards(view).total };
      } catch {
        return { ...view, count: 0 };
      }
    });
  }

  /** Add or change a view (by id). */
  saveView(input: Partial<PkmView>) {
    const name = String(input.name ?? "").trim().slice(0, 60);
    const query = String(input.query ?? "").trim().slice(0, 500);
    if (!name || !query) throw new HttpError(400, "invalid_view", "보기 이름과 조건을 적어 주세요.");
    const view: PkmView = { id: typeof input.id === "string" && input.id ? input.id : `view-${createHash("sha256").update(`${name}${Date.now()}`).digest("hex").slice(0, 10)}`, name, query, groupBy: typeof input.groupBy === "string" && input.groupBy.trim() ? input.groupBy.trim().slice(0, 80) : null };
    const views = this.views();
    const index = views.findIndex((entry) => entry.id === view.id);
    this.writeJson("pkm.views", index >= 0 ? views.map((entry) => (entry.id === view.id ? view : entry)) : [...views, view]);
    this.publish("views");
    return view;
  }

  deleteView(id: string) {
    this.writeJson("pkm.views", this.views().filter((view) => view.id !== id));
    this.publish("views");
  }

  /** Hidden: archived, in an archived work, or under an archived folder. */
  private workHidden(work: Work) {
    if (work.archivedAt) return true;
    const { folders } = this.manager.view;
    for (let at = work.folderId; at; at = folders.get(at)?.parentId ?? null) if (folders.get(at)?.archivedAt) return true;
    return false;
  }

  /** Everything a view can show, as cards with what its terms look at. */
  private viewItems(kinds: Set<PkmCard["kind"]>): ViewItem[] {
    const items: ViewItem[] = [];
    const { works, sessions } = this.manager.view;
    const index = this.vault.current;
    if (kinds.has("note") && index) {
      const pinned = new Set(this.vault.navigator?.pinned ?? []);
      const reads = this.noteReads();
      for (const entry of index.notes.values()) {
        if (this.vault.isHidden(entry.path)) continue;
        const meta = this.notes.meta(entry);
        items.push({ card: this.notes.card(entry, pinned.has(entry.path), reads[entry.path]?.length ?? 0), tags: meta.tags, properties: meta.properties, engines: [], statuses: [] });
      }
    }
    const visible = [...works.values()].filter((work) => !this.workHidden(work));
    const sessionsOf = (workId: string) => [...sessions.values()].filter((session) => session.workId === workId && !session.archivedAt);
    if (kinds.has("page")) {
      const byId = new Map(visible.map((work) => [work.id, work]));
      for (const artifact of this.manager.documents.list()) {
        const work = byId.get(artifact.workId);
        if (!work || artifact.role === "project-note") continue;
        const page = this.pageItem(artifact, work);
        items.push({ card: page.card, tags: [...page.card.tags, ...(work.tags ?? [])], properties: page.properties, engines: [], statuses: [] });
      }
    }
    for (const work of visible) {
      const own = sessionsOf(work.id);
      if (kinds.has("session")) for (const session of own) items.push({ card: this.sessionCard(session, work), tags: work.tags ?? [], properties: [], engines: [session.provider], statuses: sessionStatuses(session) });
      if (kinds.has("work")) items.push({ card: { ...this.workCard(work), tags: work.tags ?? [] }, tags: work.tags ?? [], properties: [], engines: workEngines(own), statuses: workStatuses(own) });
    }
    return items;
  }

  /** A view's cards: newest first; grouped by its key when it has one ("값 없음" for missing values). */
  viewCards(view: Pick<PkmView, "name" | "query" | "groupBy">): CardList {
    const { terms, problems } = parseViewQuery(view.query);
    const matched = filterItems(this.viewItems(kindsFor(terms)), terms);
    matched.sort((a, b) => (b.card.date ?? 0) - (a.card.date ?? 0) || a.card.title.localeCompare(b.card.title, "ko"));
    const shown = matched.slice(0, CARD_LIMIT);
    return {
      title: view.name,
      crumbs: ["보기", view.name],
      cards: shown.map((item) => item.card),
      total: matched.length,
      ...(view.groupBy && view.groupBy !== "date" ? { groups: groupItems(shown, view.groupBy) } : {}),
      ...(problems.length ? { problems } : {}),
    };
  }

  // ── rules ────────────────────────────────────────────────────────────────────────────────

  rules(): PkmRule[] {
    return cleanRules(this.readJson<unknown>("pkm.rules", []));
  }

  placements(): Record<string, RulePlacement> {
    return this.readJson<Record<string, RulePlacement>>("pkm.placements", {});
  }

  /** Save the ordered rules; works made from now on are placed by them. */
  saveRules(value: unknown) {
    const rules = cleanRules(value);
    this.writeJson("pkm.rules", rules);
    this.store.setMeta("pkm.rules.since", String(Date.now()));
    this.publish("rules");
    return rules;
  }

  private placementInputs(work: Work) {
    const { sessions } = this.manager.view;
    return {
      sessions: [...sessions.values()].filter((session) => session.workId === work.id),
      documents: this.manager.documents.list().filter((artifact) => artifact.workId === work.id),
    };
  }

  /** "미리보기": what the rules would change, work by work (nothing is changed). */
  previewRules(): RuleChange[] {
    const rules = this.rules();
    const changes: RuleChange[] = [];
    for (const work of this.manager.view.works.values()) {
      if (this.workHidden(work)) continue;
      const { sessions, documents } = this.placementInputs(work);
      const placement = placementFor(rules, work, sessions, documents);
      if (!placement) continue;
      const from = this.folderTrail(work.folderId).join("/") || null;
      const to = placement.folder ?? from;
      const tag = placement.tag && !(work.tags ?? []).includes(placement.tag) ? placement.tag : null;
      const pin = placement.pin && !work.pinned;
      if (to === from && !tag && !pin) continue;
      changes.push({ workId: work.id, title: work.title, ruleId: placement.rule.id, ruleName: placement.rule.name, from, to, tag, pin, suggested: work.folderId === null });
    }
    return changes;
  }

  /** "적용": place the chosen works by the rules (the user picked them in the preview). */
  applyRules(workIds: string[]) {
    let applied = 0;
    for (const workId of workIds) {
      const work = this.manager.view.works.get(workId);
      if (!work || this.workHidden(work)) continue;
      if (this.place(work)) applied += 1;
    }
    return { applied };
  }

  /** The folder at an app folder path ("강의/2026"), made where missing. */
  private ensureFolder(path: string) {
    let parentId: string | null = null;
    for (const name of path.split("/").map((part) => part.trim()).filter(Boolean)) {
      const existing = [...this.manager.view.folders.values()].find((folder) => folder.parentId === parentId && folder.name === name && !folder.archivedAt);
      parentId = existing ? existing.id : this.manager.createFolder(name, parentId).id;
    }
    return parentId;
  }

  /** Put a work where the first matching rule says, and remember which rule did it. */
  private place(work: Work) {
    const { sessions, documents } = this.placementInputs(work);
    const placement = placementFor(this.rules(), work, sessions, documents);
    if (!placement) return false;
    const folderId = placement.folder ? this.ensureFolder(placement.folder) : work.folderId;
    const tags = placement.tag && !(work.tags ?? []).includes(placement.tag) ? [...(work.tags ?? []), placement.tag] : undefined;
    this.manager.updateWork(work.id, { folderId, ...(placement.pin ? { pinned: true } : {}), ...(tags ? { tags } : {}) });
    this.writeJson("pkm.placements", { ...this.placements(), [work.id]: { ruleId: placement.rule.id, ruleName: placement.rule.name, at: Date.now() } });
    this.publish("rules");
    return true;
  }

  private readonly pendingPlacement = new Set<string>();

  /** A new work not filed yet: placed once, by the first matching rule, after the event that told us. */
  private schedulePlacement(workId: string) {
    if (this.pendingPlacement.has(workId)) return;
    this.pendingPlacement.add(workId);
    setTimeout(() => {
      this.pendingPlacement.delete(workId);
      const work = this.manager.view.works.get(workId);
      const since = Number(this.store.getMeta("pkm.rules.since") ?? Infinity);
      if (!work || work.folderId !== null || this.workHidden(work) || work.createdAt < since || this.placements()[workId]) return;
      if (!this.rules().some((rule) => rule.enabled)) return;
      try {
        this.place(work);
      } catch {
        // A rule that cannot be applied now (a folder name the gateway refused) leaves the work where it is.
      }
    }, 0);
  }

  // ── notes and pictures ───────────────────────────────────────────────────────────────────

  note(path: string): VaultNote {
    if (this.vault.isHidden(path)) throw new HttpError(404, "note_missing", "숨긴 폴더의 노트입니다.");
    try {
      return this.notes.note(path, this.sessionsOf(path));
    } catch (error) {
      throw new HttpError(404, "note_missing", error instanceof Error ? error.message : String(error));
    }
  }

  /** A picture of the vault (only image files, only inside the vault). */
  vaultImage(path: string) {
    if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) throw new HttpError(415, "not_image", "그림 파일만 보여 줍니다.");
    let file: string;
    try {
      file = this.vault.resolve(path);
    } catch (error) {
      throw new HttpError(403, "outside", error instanceof Error ? error.message : String(error));
    }
    if (!existsSync(file)) throw new HttpError(404, "not_found", "그림이 없습니다.");
    return file;
  }

  /** A picture next to a page of a work (inside the work folder only). */
  pageImage(artifactId: string, src: string) {
    const artifact = this.manager.documents.get(artifactId);
    const work = this.manager.view.works.get(artifact.workId);
    if (!work || !IMAGE_EXTENSIONS.has(extname(src).toLowerCase()) || /^[a-z]+:/i.test(src) || isAbsolute(src)) throw new HttpError(404, "not_found", "그림이 없습니다.");
    const file = resolve(dirname(artifact.path), decodeURIComponent(src));
    const inside = relative(realpathSync(work.cwd), existsSync(file) ? realpathSync(file) : file);
    if (!inside || inside.startsWith("..") || isAbsolute(inside) || !existsSync(file)) throw new HttpError(404, "not_found", "그림이 없습니다.");
    return file;
  }

  // ── pages: templates, subpages, a session or a message as a page ─────────────────────────

  protected requireWork(workId: string) {
    const work = this.manager.view.works.get(workId);
    if (!work) throw new HttpError(404, "work_not_found", "작업을 찾지 못했습니다.");
    return work;
  }

  private templateSources(work: Work | null): TemplateSource[] {
    const sources: TemplateSource[] = [];
    if (this.options.dataDir) sources.push({ source: "global", dir: join(this.options.dataDir, "templates") });
    if (work) sources.push({ source: "work", dir: join(work.cwd, WORKBENCH_DIR, "templates") });
    if (this.vault.root && this.vault.current) sources.push({ source: "vault", dir: join(this.vault.root, VAULT_TEMPLATES) });
    return sources;
  }

  /** Templates for a new page of this work: the app's, the work's, and the vault's (read only). */
  templates(workId: string): PageTemplate[] {
    return this.templateSources(this.requireWork(workId)).flatMap(readTemplates);
  }

  /** Write a new page without ever replacing a file (a number is added to a taken name), and track it. */
  private writePage(work: Work, dir: string, stem: string, text: string, note: string): Artifact {
    mkdirSync(dir, { recursive: true });
    let path = join(dir, `${stem}.md`);
    for (let index = 2; existsSync(path); index += 1) path = join(dir, `${stem} ${index}.md`);
    writeFileSync(path, text, { flag: "wx" });
    const tracked = this.manager.documents.track(work.id, work.cwd, path, "user", null, note);
    if (!tracked) throw new HttpError(500, "page_not_tracked", "페이지를 만들지 못했습니다.");
    return tracked.artifact;
  }

  /** The folder a page's subpages live in: `A.md` → `A/` beside it (as Obsidian folder notes do). */
  private subpageDir(parentId: string) {
    const parent = this.manager.documents.get(parentId);
    if (parent.format !== "markdown") throw new HttpError(400, "not_page", "마크다운 페이지에만 하위 페이지를 만들 수 있습니다.");
    return { parent, dir: join(dirname(parent.path), basename(parent.path).replace(/\.(md|markdown)$/i, "")) };
  }

  /** A new page from a template, in the work folder or under a page (its subpage). */
  pageFromTemplate(workId: string, templateId: string, title: string, choices: Record<string, string[]>, parentId: string | null) {
    const work = this.requireWork(workId);
    const file = templateFile(templateId, this.templateSources(work));
    if (!file) throw new HttpError(404, "template_missing", "템플릿을 찾지 못했습니다.");
    const name = safeStem(title, "제목 없음");
    const source = readFileSync(file, "utf8");
    // Only the template's own choice fields, and only options it offers.
    const allowed = Object.fromEntries(templateChoices(source).map((choice) => [choice.key, (choices[choice.key] ?? []).filter((value) => choice.options.includes(value))]));
    const text = fillTemplate(source, { title: title.replace(/[\r\n]+/g, " ").trim() || name, date: localStamp(), choices: allowed });
    const dir = parentId ? this.subpageDir(parentId).dir : work.cwd;
    return this.writePage(work, dir, name, text, `템플릿 「${templateId.slice(templateId.indexOf(":") + 1).replace(/\.md$/i, "")}」에서`);
  }

  /** A blank subpage of a page: `A.md` gets `A/<name>.md`; `A.md` itself never moves. */
  subpage(parentId: string, name: string) {
    const { parent, dir } = this.subpageDir(parentId);
    const work = this.requireWork(parent.workId);
    const stem = safeStem(name, "제목 없음");
    return this.writePage(work, dir, stem, `# ${stem}\n\n`, `「${parent.name}」의 하위 페이지`);
  }

  /**
   * "세션 기록 페이지": a session dropped on a work becomes a page of that work, made by the same
   * fixed rules as "마크다운으로 내보내기". In its own work it is that export (updated in place).
   */
  sessionPage(sessionId: string, workId: string) {
    const session = this.manager.view.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "session_not_found", "세션을 찾지 못했습니다.");
    const work = this.requireWork(workId);
    if (session.workId === workId) {
      const result = this.manager.exportMarkdown(sessionId, { target: "work" });
      if (!result.artifactId) throw new HttpError(500, "page_not_tracked", "세션 기록 페이지를 만들지 못했습니다.");
      return this.manager.documents.get(result.artifactId);
    }
    const { markdown } = this.manager.exportMarkdown(sessionId, { target: "text" });
    const first = this.manager.items(sessionId).items[0]?.at ?? session.createdAt;
    const name = exportFileName(session, first).replace(/\.md$/, "");
    return this.writePage(work, join(work.cwd, "세션 기록"), name, markdown, `「${session.purpose}」 세션 기록`);
  }

  /** "페이지로 만들기": a message (or the part of it the user selected) as a page of its work. */
  messagePage(sessionId: string, itemId: string, selection: string | null) {
    const session = this.manager.view.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "session_not_found", "세션을 찾지 못했습니다.");
    const item = this.manager.items(sessionId).items.find((entry) => entry.id === itemId);
    if (!item || (item.kind !== "assistant" && item.kind !== "user")) throw new HttpError(404, "message_missing", "메시지를 찾지 못했습니다.");
    // Only text of that message: a selection that is not part of it falls back to the whole message.
    const picked = selection?.trim() && item.text.includes(selection.trim()) ? selection.trim() : item.text;
    const title = headingOf(picked);
    const text = ["---", `title: ${yamlValue(title)}`, `source: workbench://session/${sessionId}#${encodeURIComponent(itemId)}`, `date created: ${localStamp()}`, "---", "", tidyMessage(picked), ""].join("\n");
    return this.writePage(this.requireWork(session.workId), this.requireWork(session.workId).cwd, safeStem(title, "대화에서"), text, "대화에서 만든 페이지");
  }

  // ── insight drafts ───────────────────────────────────────────────────────────────────────

  private insightSource(sessionId: string) {
    const session = this.manager.view.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "session_not_found", "세션을 찾지 못했습니다.");
    const work = this.requireWork(session.workId);
    const items = this.manager.items(sessionId).items;
    const ids = [...new Set(items.flatMap((item) => (item.kind === "artifact" ? [item.artifactId] : [])))];
    const documents = ids.flatMap((id) => {
      try {
        const artifact = this.manager.documents.get(id);
        return [{ name: artifact.name, revision: artifact.revision }];
      } catch {
        return [];
      }
    });
    return { session, work, items, documents };
  }

  /** "인사이트 초안" of a session: built by fixed rules, with the vault template's keys. */
  insight(sessionId: string): InsightDraft {
    const source = this.insightSource(sessionId);
    if (!source.items.some((item) => item.kind === "turnEnd" && item.status === "completed")) throw new HttpError(409, "not_finished", "끝난 응답이 있는 세션에서 초안을 만들 수 있습니다.");
    const draft = insightDraft(source, insightTemplate(this.vault.root, VAULT_TEMPLATES));
    return { sessionId, ...draft, problems: checkInsight(draft.text, draft.keys) };
  }

  /** What keeps a reviewed draft from being published (the same keys as its draft). */
  checkInsight(sessionId: string, text: string) {
    const keys = this.insight(sessionId).keys;
    return { problems: checkInsight(text, keys) };
  }

  /**
   * Publish a reviewed draft the approved way: the session's own engine is asked to call its
   * Achmage MCP tools (draft_insight, then publish_insight) with exactly this text. Workbench
   * writes nothing into the vault; the answer comes back in the conversation.
   */
  async publishInsight(sessionId: string, text: string, requestId: string) {
    const draft = this.insight(sessionId);
    const problems = checkInsight(text, draft.keys);
    if (problems.length) throw new HttpError(400, "insight_invalid", problems.join(" "));
    const title = /^title\s*:\s*(.*)$/m.exec(splitFrontmatter(text).yaml ?? "")?.[1]?.replace(/^"(.*)"$/, "$1").trim() || draft.title;
    const result = await this.manager.send(sessionId, requestId, publishRequest({ title, summary: draft.summary, text }), [], null, null, "queue");
    const sent = this.readJson<{ sessionId: string; title: string; requestId: string; at: number }[]>("pkm.insights", []);
    this.writeJson("pkm.insights", [...sent.slice(-99), { sessionId, title, requestId, at: Date.now() }]);
    this.publish("insights");
    return { ...result, requestId };
  }

  close() {
    this.vault.close();
  }
}
