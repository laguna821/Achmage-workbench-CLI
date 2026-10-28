import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { PROVIDER_LABEL, type Artifact, type CardList, type PageTemplate, type PkmCard, type PkmScope, type PkmState, type Session, type VaultNote, type Work } from "@workbench/contracts";
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
export type CardTarget = { kind: "vault"; path: string; descendants: boolean } | { kind: "folder"; id: string } | { kind: "work"; id: string };

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
  protected readonly manager: SessionManager;
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
    return { vault: this.vault.status() };
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
    for (const artifact of this.manager.documents.list().filter((entry) => entry.workId === workId)) {
      let excerpt = "";
      let tags: string[] = [];
      let thumb: PkmCard["thumb"] = null;
      let stage: string | null = null;
      let title = artifact.name;
      let date = artifact.updatedAt;
      let dateKind: PkmCard["dateKind"] = "modified";
      if (artifact.format === "markdown" || artifact.format === "text") {
        try {
          const { yaml, body } = splitFrontmatter(readHead(this.manager.documents.revisionPath(artifact.id, artifact.revision)));
          const properties = parseFrontmatter(yaml);
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
        } catch {
          // A revision that cannot be read now is listed by its name.
        }
      }
      cards.push({ kind: "page", id: artifact.id, title, excerpt, tags, date, dateKind, thumb, pinned: false, stage, format: artifact.format, workId, where: relative(work.cwd, artifact.path) });
    }
    cards.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.date ?? 0) - (a.date ?? 0));
    return { title: work.title, crumbs: ["작업 공간", ...this.folderTrail(work.folderId), work.title], cards: cards.slice(0, CARD_LIMIT), total: cards.length };
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

  close() {
    this.vault.close();
  }
}
