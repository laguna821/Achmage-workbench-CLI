import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { diffLines } from "diff";
import {
  DESIGN_EXTENSION,
  formatOf,
  isOfficeFormat,
  type Artifact,
  type ArtifactRevision,
  type DocFormat,
  type DocRef,
  type DocumentAccess,
  type Proposal,
  type ProposalCloser,
  type Provenance,
  type RefSummary,
  type RenameJournal,
  type TurnBreak,
} from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";
import type { Kordoc } from "./kordoc.ts";
import { hangulPages } from "./hwp-pages.mjs";
import { designAssetPath, designGuide, designProblem, designStem, saveDesignAsset } from "./design.ts";
import type { IeumOffice, OfficePage } from "./ieumoffice.ts";
import { BackgroundIndex } from "./doc-text.ts";
import { PagePictures, PICTURE_CACHE_BOUND, sweepPictures, type PicturesOptions } from "./page-pictures.ts";
import { hangulPicture, pictureSvg } from "./channels/hangul-picture-run.ts";
import { DocumentRegistry } from "./document-registry.ts";
import { writeAtomic } from "./atomic-write.ts";
import { DesignDrafts } from "./design-drafts.ts";
import { hwpToText } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { withHwpDocument } from "./hwp-document.ts";
import { hwpStructureOf, lostStructure } from "./hwp-structure.ts";
import { hwpFormat, openHwpBytes, prepareHwpSave } from "./hwp-codec.ts";

// Documents with exact revisions (PRD 3.3). Every recorded revision is an immutable copy under the
// gateway's data folder; the real file stays where it is in the work folder. AI edits happen in a
// working copy of a pinned revision and only reach the real file when the user applies them, and
// only if the document has not moved on since.

/** Files the app writes for engines inside a work folder; never tracked as documents themselves. */
export const WORKBENCH_DIR = ".workbench";

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function readFileOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * File system steps a test can stand in for (a failing link, another device, a file system where two
 * names are one entry, storage without hard links, a file another program holds).
 */
export const fileOps = {
  link: (from: string, to: string) => linkSync(from, to),
  device: (path: string) => statSync(path).dev,
  unlink: (path: string) => unlinkSync(path),
  rename: (from: string, to: string) => renameSync(from, to),
  lstat: (path: string) => lstatSync(path),
  readdir: (dir: string): string[] => readdirSync(dir),
  read: (path: string) => readFileSync(path),
  /** An exclusive copy (never over a file). */
  copy: (from: string, to: string) => copyFileSync(from, to, fsConstants.COPYFILE_EXCL),
  /** The file's bytes on the disk before going on. */
  syncFile: (path: string) => {
    const fd = openSync(path, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  },
  /** A folder's new or removed name on the disk; where the platform cannot (Windows), nothing. */
  syncDir: (dir: string) => {
    let fd: number | undefined;
    try { fd = openSync(dir, "r"); fsyncSync(fd); } catch { /* not possible here */ } finally { if (fd !== undefined) closeSync(fd); }
  },
};

const exists = (path: string) => {
  try { fileOps.lstat(path); return true; } catch { return false; }
};

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** What identifies the person's file in a rename journal: its size, content hash and dev:ino. */
function fileIdentity(path: string) {
  const entry = fileOps.lstat(path);
  return { size: entry.size, sha256: sha256(fileOps.read(path)), fileId: `${entry.dev}:${entry.ino}` };
}

/** Is the file at `path` the one the journal recorded (an older journal recorded nothing: yes). */
function holdsJournalled(path: string, journal: RenameJournal) {
  try {
    const entry = fileOps.lstat(path);
    if (!entry.isFile()) return false;
    if (journal.sha256 === undefined) return true;
    if (journal.mode !== "copy" && journal.fileId === `${entry.dev}:${entry.ino}`) return true;
    return entry.size === journal.size && sha256(fileOps.read(path)) === journal.sha256;
  } catch {
    return false;
  }
}

/**
 * Are `from` and `to` two directory entries (both listed, byte-different names)? false: one entry the
 * file system finds under both names (letter case, NFC/NFD). null: the folder could not be read.
 */
function twoEntries(from: string, to: string): boolean | null {
  const a = basename(from), b = basename(to);
  if (a === b) return false;
  try {
    const names = fileOps.readdir(dirname(from));
    return names.includes(a) && names.includes(b);
  } catch {
    return null;
  }
}

/**
 * Move a file on one file system without ever replacing one: an exclusive hard link (fails when
 * the name is taken), then the old name's removal. If that removal fails the new name goes again,
 * so there are never two; nothing else is ever deleted.
 */
function moveByLink(from: string, to: string) {
  fileOps.link(from, to);
  try {
    unlinkSync(from);
  } catch (error) {
    unlinkSync(to);
    throw error;
  }
}

/** Names Windows keeps for devices, the superscript-digit forms too (refused everywhere, so a project can travel). */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * The file name a typed document name becomes (이름 바꾸기), or a plain refusal before anything is
 * tried on disk: the same extension, byte for byte (added when it is not typed; typed in another
 * letter case it is the original's), no character an OS refuses (`/ \ : * ? " < > |`, control
 * characters), no device name, no hidden (`.…`) or Office lock-file (`~$…`) name, no trailing dot or
 * space, at most 255 bytes.
 */
export function documentFileName(artifact: Pick<Artifact, "format" | "name">, typed: string): string {
  const name = typed.trim();
  if (!name) throw new HttpError(400, "rename_empty", "새 이름을 적어 주세요.");
  if (/[/\\:*?"<>|\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, "rename_chars", "이름에 쓸 수 없는 글자가 있습니다: / \\ : * ? \" < > | 와 줄바꿈·탭.");
  const extension = extensionOf(artifact);
  const lower = name.toLowerCase();
  let full = name;
  if (!extension || !lower.endsWith(extension.toLowerCase())) {
    const typedFormat = formatOf(name);
    if (typedFormat && extname(name)) throw new HttpError(400, "rename_extension", `확장자는 바꿀 수 없습니다(${extension}). 이름만 고쳐 주세요.`);
    full = `${name}${extension}`;
  } else {
    // Revision copies are named by the extension: it keeps its original bytes (B.MD for 강의안.md is B.md).
    full = `${name.slice(0, name.length - extension.length)}${extension}`;
  }
  const stem = full.slice(0, full.length - extension.length);
  if (!stem || /^\.+$/.test(name) || RESERVED_NAMES.test(stem.split(".")[0]!)) throw new HttpError(400, "rename_reserved", "그 이름은 컴퓨터가 쓰는 이름이라 쓸 수 없습니다.");
  if (full.startsWith(".")) throw new HttpError(400, "rename_hidden", "점(.)으로 시작하는 이름은 숨김 파일이 되어 쓸 수 없습니다.");
  if (full.startsWith("~$")) throw new HttpError(400, "rename_lockname", "~$로 시작하는 이름은 오피스 프로그램의 임시 파일 이름이라 쓸 수 없습니다.");
  if (/[. ]$/.test(full) || /[. ]$/.test(stem)) throw new HttpError(400, "rename_trailing", "이름 끝에 점이나 빈칸은 쓸 수 없습니다.");
  if (Buffer.byteLength(full, "utf8") > 255) throw new HttpError(400, "rename_long", "이름이 너무 깁니다. 조금 줄여 주세요.");
  return full;
}

/** A Markdown link target as it was written: `<…>`, percent-encoded, or plain (spaces then need `<…>`). */
function linkTarget(original: string, name: string) {
  if (original.startsWith("<")) return `<${name}>`;
  if (/%[0-9a-f]{2}/i.test(original)) return encodeURIComponent(name);
  return /[\s()<>]/.test(name) ? `<${name}>` : name;
}

/** Code the note shows as code (fenced blocks, inline spans): links inside it are not links. */
const CODE_IN_MARKDOWN = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^\n]*?\2/g;

/**
 * The project note's links to a renamed document, rewritten only where they resolve to this file:
 * `[[name]]` (with `|alias` or `#heading`), the bare `[[stem]]` only for a Markdown document (that is
 * what it resolves to; `[[계획]]` never means 계획.hwpx), and Markdown links `](name)`, `](<name>)`,
 * `](./name)`, `](percent-encoded)` in the same folder, `#section` kept. Code spans and fenced code,
 * other text, and links to other files stay byte for byte.
 */
export function renameLinks(text: string, from: string, to: string, extension: string): { text: string; count: number } {
  const fromStem = from.slice(0, from.length - extension.length), toStem = to.slice(0, to.length - extension.length);
  const bareStem = extension.toLowerCase() === ".md";
  let count = 0;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wiki = new RegExp(`\\[\\[(${escape(from)}${bareStem ? `|${escape(fromStem)}` : ""})(?=[|#\\]])`, "g");
  const decoded = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  const rewrite = (part: string) => part
    .replace(wiki, (_whole, target: string) => {
      count += 1;
      return `[[${target === from ? to : toStem}`;
    })
    .replace(/\]\((<[^>\n]*>|[^)\s]+)((?:\s+"[^"\n]*")?)\)/g, (whole, target: string, title: string) => {
      const angled = target.startsWith("<");
      const inner = angled ? target.slice(1, -1) : target;
      const hashAt = inner.indexOf("#");
      const path = hashAt === -1 ? inner : inner.slice(0, hashAt), anchor = hashAt === -1 ? "" : inner.slice(hashAt);
      const prefix = path.startsWith("./") ? "./" : "";
      const plain = path.slice(prefix.length);
      if (plain !== from && decoded(plain) !== from) return whole;
      count += 1;
      const written = linkTarget(angled ? `<${plain}>` : plain, to);
      return written.startsWith("<") ? `](<${prefix}${to}${anchor}>${title})` : `](${prefix}${written}${anchor}${title})`;
    });
  let out = "", last = 0;
  for (const code of text.matchAll(CODE_IN_MARKDOWN)) {
    out += rewrite(text.slice(last, code.index)) + code[0];
    last = code.index + code[0].length;
  }
  out += rewrite(text.slice(last));
  return { text: out, count };
}

const isHangul = (format: string) => format === "hwpx" || format === "hwp";
/** Pre-native proposals contain Markdown, identified by their persisted path, never by a new default. */
const legacyHangulProposal = (artifact: Artifact, proposal: Proposal) => isHangul(artifact.format) && /\.hwpx?\.md$/i.test(proposal.workingPath);

/** Formats searched through their editor engine's text view instead of binary bytes. */
/** Formats whose tab can show the first page as a picture while its editor opens. */
const pictured = (format: DocFormat) => isOfficeFormat(format) || format === "hwpx" || format === "hwp";
const hasTextView = (format: DocFormat) => isHangul(format) || isOfficeFormat(format) || format === "xmind" || format === "epub";

/** Extension kept on copies of a document (designs keep their two-part `.design.json`). */
const extensionOf = (artifact: Pick<Artifact, "format" | "name">) => (artifact.format === "design" ? DESIGN_EXTENSION : extname(artifact.name));

export function isWorkbenchPath(path: string) {
  const parts = path.split(/[\\/]/);
  const at = parts.lastIndexOf(WORKBENCH_DIR);
  // The project note of a work in a git repository (project.ts) is a real document of the work.
  return at !== -1 && !(at === parts.length - 2 && parts[at + 1] === PROJECT_NOTE_IN_GIT);
}

/** The project note's name inside `.workbench/` when the work folder is a git repository. */
export const PROJECT_NOTE_IN_GIT = "project.md";

/** Text formats searched as they are (HTML without its tags). */
const SEARCHED_AS_TEXT = new Set(["markdown", "text", "html"]);

function searchText(format: string, data: Buffer): string | null {
  if (!SEARCHED_AS_TEXT.has(format)) return null;
  const text = data.toString("utf8");
  if (format !== "html") return text;
  return text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Bumped when what the document index holds changes; documents are then indexed again once.
 * 3: Hangul text is read by the same pinned rhwp WASM as its editor; old patch views stay intact.
 * 2: Hangul and Office documents by their text view, made in the background (they dropped out
 * before), and no entries left under old row ids (older revisions' text was still found).
 */
const DOCUMENT_SEARCH_VERSION = "3";

function countChanges(before: string, after: string) {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

export class Documents {
  readonly registry: DocumentRegistry;
  readonly designDrafts: DesignDrafts;
  private readonly artifacts = new Map<string, Artifact>();
  /** Documents taken out of their projects (보관함), restorable until deleted for good. */
  private readonly removedDocs = new Map<string, Artifact>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly root: string;
  readonly kordoc: Kordoc | null;
  /** Word/PowerPoint/Excel engine; replaced when IeumOffice is installed while the gateway runs. */
  ieum: IeumOffice | null;
  private readonly pageCache = new Map<string, Promise<import("./kordoc.ts").HangulPage[]>>();
  private readonly officeCache = new Map<string, Promise<OfficePage[]>>();
  /** Hangul and Office revisions waiting for their text to be indexed (one at a time). */
  readonly textIndex = new BackgroundIndex((artifactId, revision) => this.indexView(artifactId, revision));
  /** Office renders a page view asked for now (the background pictures wait while one runs). */
  private rendering = 0;
  /**
   * Page pictures made ahead when a revision is recorded (doc-pages-first): off until the gateway
   * turns them on (`enablePictures`), so tests never start the picture child by themselves.
   */
  pictures: PagePictures | null = null;
  pictureBound = PICTURE_CACHE_BOUND;

  private readonly workspaces: Workspaces | null;
  readonly dataDir: string;
  constructor(store: Store, bus: EventBus, dataDir: string, kordoc: Kordoc | null = null, ieum: IeumOffice | null = null, workspaces: Workspaces | null = null) {
    this.dataDir = dataDir;
    this.workspaces = workspaces;
    this.registry = new DocumentRegistry((id) => this.get(id), Date.now, workspaces?.directoryOperations);
    this.store = store;
    this.bus = bus;
    this.root = join(dataDir, "artifacts");
    this.designDrafts = new DesignDrafts(join(dataDir, "design-drafts"), this);
    this.kordoc = kordoc;
    this.ieum = ieum;
    for (const artifact of store.artifacts()) (artifact.removed ? this.removedDocs : this.artifacts).set(artifact.id, { ...artifact, readBy: artifact.readBy ?? {} });
    this.reconcileTrash();
    this.reconcileRenames();
    // Proposals a restart left running are finished by the session manager, with the turn it cut.
    for (const proposal of store.proposals()) this.proposals.set(proposal.id, proposal);
    if (store.getMeta("search.documents") !== DOCUMENT_SEARCH_VERSION) {
      // v3 changes the Hangul reader. Keep a v2 entry until the new engine has read its file.
      if (store.getMeta("search.documents") !== "2") store.clearDocumentIndex();
      for (const artifact of this.artifacts.values()) {
        if (hasTextView(artifact.format)) this.textIndex.add(artifact.id, artifact.revision);
        else this.indexLatest(artifact);
      }
      store.setMeta("search.documents", DOCUMENT_SEARCH_VERSION);
    }
  }

  /**
   * Keep the search index on a document's latest revision: text formats as they are, Hangul and
   * Office files through their text view (made in the background when not kept yet).
   */
  private indexLatest(artifact: Artifact) {
    if (artifact.revision < 1) return;
    if (hasTextView(artifact.format)) {
      // Found by its name at once, by its text once the background has read it.
      this.store.indexDocument(artifact.id, null);
      this.textIndex.add(artifact.id, artifact.revision);
      return;
    }
    try {
      const data = readFileOrNull(join(this.root, artifact.id, `r${artifact.revision}${extname(artifact.path)}`));
      this.store.indexDocument(artifact.id, data ? searchText(artifact.format, data) : null);
    } catch {
      // Search is a convenience: a document that cannot be read now is found again after its next change.
    }
  }

  /**
   * Index a Hangul or Office revision by its text view, kept with the revision (made by its
   * editor engine when absent). Only while it is still latest; a failed read changes no entry.
   */
  private async indexView(artifactId: string, revision: number) {
    const latest = () => this.artifacts.get(artifactId)?.revision === revision;
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || !latest() || !hasTextView(artifact.format)) return;
    const kept = this.viewCachePath(artifact, revision);
    let text = readFileOrNull(kept)?.toString("utf8") ?? null;
    if (text === null) {
      text = await this.extractText(join(this.root, artifactId, `r${revision}${extname(artifact.path)}`), artifact.format);
      if (text === null) return;
      if (!existsSync(kept)) writeFileSync(kept, text);
    }
    if (latest()) this.store.indexDocument(artifactId, text);
  }

  /** The text view from the native Hangul WASM or Office reader. */
  private async extractText(file: string, format: DocFormat): Promise<string | null> {
    if (format === "epub") return (await import("./epub-ops.mjs")).epubText(readFileSync(file));
    if (format === "xmind") return (await import("./mindmap-ops.mjs")).mindmapText(readFileSync(file));
    if (isHangul(format)) return hwpToText(readFileSync(file));
    if (isOfficeFormat(format)) return this.ieum?.available ? this.ieum.textView(file, format) : null;
    return null;
  }

  list() {
    return [...this.artifacts.values()];
  }

  /** Forget a deleted project's documents; `keep`: its trashed ones (marked orphaned by the caller). */
  forgetWork(workId: string, keep: ReadonlySet<string> = new Set()) {
    for (const [id, artifact] of this.removedDocs) if (artifact.workId === workId && !keep.has(id)) this.removedDocs.delete(id);
    const ids = new Set(this.list().filter(artifact => artifact.workId === workId).map(artifact => artifact.id));
    for (const view of this.registry.list()) if (ids.has(view.artifactId)) this.registry.close(view.viewId, view.windowId);
    for (const id of ids) this.artifacts.delete(id);
    for (const [id, proposal] of this.proposals) if (ids.has(proposal.artifactId)) this.proposals.delete(id);
  }

  removedList() {
    return [...this.removedDocs.values()];
  }

  /** A document, listed or removed (undefined when neither). */
  find(artifactId: string): Artifact | undefined {
    return this.artifacts.get(artifactId) ?? this.removedDocs.get(artifactId);
  }

  /** Trash files without a record, records without their file, moves left unfinished (reported, never deleted). */
  readonly trashReport: string[] = [];

  private saveRemoved(artifact: Artifact) {
    this.artifacts.delete(artifact.id);
    this.removedDocs.set(artifact.id, artifact);
    this.store.saveArtifact(artifact);
  }

  /** A removed record's pending step done: kept removed (`removed`), or listed again. */
  private settle(artifact: Artifact, removed: Artifact["removed"] | null) {
    if (removed) {
      this.saveRemoved({ ...artifact, removed });
      return;
    }
    const { removed: _gone, ...live } = artifact;
    this.removedDocs.delete(artifact.id);
    this.save(live);
  }

  /** The app's trash folder (created on first use, private). */
  trashRoot() {
    const root = join(this.dataDir, "trash");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }

  /**
   * Take a document out of its project. "unlisted" touches no file. "trash" is called by the
   * session manager only after it proved the narrow case in the same synchronous step: the move is
   * recorded first, made with an exclusive link on one file system, then marked done. A failed move
   * leaves the document as it was. Its revisions stay; its open proposals are closed.
   */
  remove(artifactId: string, kind: "trash" | "unlisted", sessionIds: string[] = []): Artifact {
    const artifact = this.get(artifactId);
    let removed: NonNullable<Artifact["removed"]> = { at: Date.now(), kind, ...(sessionIds.length ? { sessionIds } : {}) };
    if (kind === "trash") {
      const folder = join(this.trashRoot(), `${artifactId}-${randomUUID().slice(0, 8)}`);
      mkdirSync(folder, { mode: 0o700 });
      removed = { ...removed, trashPath: join(folder, artifact.name), source: artifact.path };
      this.store.saveArtifact({ ...artifact, removed: { ...removed, pending: "moving" } });
      try {
        moveByLink(artifact.path, removed.trashPath!);
      } catch (error) {
        try { rmdirSync(folder); } catch { /* only ever empty here */ }
        this.store.saveArtifact(artifact);
        throw new HttpError(500, "move_failed", `파일을 앱 휴지통으로 옮기지 못했습니다(${(error as Error).message}). 문서는 그대로입니다.`);
      }
    }
    for (const proposal of this.proposals.values()) if (proposal.artifactId === artifactId) this.discardProposal(proposal.id);
    const done: Artifact = { ...artifact, removed };
    this.store.saveArtifact(done);
    this.artifacts.delete(artifactId);
    this.removedDocs.set(artifactId, done);
    this.store.removeDocumentEntry(artifactId);
    this.bus.publish({ type: "artifact.removed", artifact: done });
    return done;
  }

  /**
   * Back to its project's list, never over anything (a file, a folder or a dangling link at its
   * path): a trashed file comes back by an exclusive link. Its id and revisions are intact. A
   * document whose project was deleted cannot come back (there is no list); save a copy instead.
   */
  restore(artifactId: string, projectExists: boolean): Artifact {
    const artifact = this.removedDocs.get(artifactId);
    if (!artifact?.removed) throw new HttpError(404, "artifact_not_removed", "보관함에 그 문서가 없습니다.");
    if (artifact.removed.orphaned || !projectExists) throw new HttpError(409, "project_gone", "프로젝트를 지워 되돌릴 목록이 없습니다. \"다른 곳에 저장\"으로 파일을 꺼내 주세요.");
    if (this.list().some((other) => other.workId === artifact.workId && other.path === artifact.path)) {
      throw new HttpError(409, "restore_conflict", `「${artifact.name}」 문서가 이미 목록에 있습니다. 그 문서를 먼저 빼거나 이름을 바꾼 뒤 되돌리세요.`);
    }
    const { trashPath } = artifact.removed;
    if (artifact.removed.kind === "trash" && trashPath) {
      if (!exists(trashPath)) throw new HttpError(409, "trash_file_missing", "휴지통에 이 문서의 파일이 없습니다.");
      if (exists(artifact.path)) throw new HttpError(409, "restore_conflict", `「${artifact.name}」 자리에 이미 파일이 있습니다. 그 파일을 옮기거나 이름을 바꾼 뒤 되돌리세요. (${artifact.path})`);
      if (!exists(dirname(artifact.path))) throw new HttpError(409, "restore_folder_missing", `원래 폴더가 없습니다(${dirname(artifact.path)}).`);
      this.store.saveArtifact({ ...artifact, removed: { ...artifact.removed, pending: "restoring" } });
      try {
        moveByLink(trashPath, artifact.path);
      } catch (error) {
        this.store.saveArtifact(artifact);
        throw new HttpError(500, "move_failed", `파일을 되돌리지 못했습니다(${(error as Error).message}). 보관함에 그대로 있습니다.`);
      }
      try { rmdirSync(dirname(trashPath)); } catch { /* not empty: left as it is */ }
    }
    this.settle(artifact, null);
    this.indexLatest(this.get(artifactId));
    return this.check(artifactId);
  }

  /** Paths a document had before a rename in this gateway's run (an open editor still names the old one). */
  private readonly formerPaths = new Map<string, Set<string>>();

  /** Is `path` this document's file: its path now, or one it had before a rename while its editor stayed open. */
  isPathOf(artifactId: string, path: string) {
    return this.get(artifactId).path === path || Boolean(this.formerPaths.get(artifactId)?.has(path));
  }

  /**
   * 이름 바꾸기: the file renamed inside its folder, never over another file. Recorded first (`renaming`,
   * committed with a full sync, with what identifies the file), then moved: by an exclusive hard link
   * and the old name's removal; where the two names are one directory entry on this file system (letter
   * case, NFC/NFD), by a plain rename (it cannot replace another file there); on storage without hard
   * links, by an exclusive copy checked against the file before the old name goes. The folder is synced
   * after each step where the platform allows. Then the record follows; a failed record update puts
   * the file back. Refused when another record uses the same file. The caller (the session manager)
   * has refused it while an AI works there. Revisions, page pictures and the search entry are kept by
   * id; this document's open editors follow the file (registry.moved).
   */
  rename(artifactId: string, typed: string): { artifact: Artifact; from: string } {
    const artifact = this.get(artifactId);
    if (artifact.renaming) throw new HttpError(409, "rename_unfinished", `앞서 한 이름 바꾸기가 아직 끝나지 않았습니다(「${basename(artifact.renaming.from)}」 → 「${basename(artifact.renaming.to)}」). 파일을 연 프로그램을 닫고 앱을 다시 시작하면 정리됩니다.`);
    const name = documentFileName(artifact, typed);
    const from = artifact.path, to = join(dirname(from), name), dir = dirname(from), oldName = basename(from);
    if (to === from) return { artifact, from };
    let entry;
    try { entry = fileOps.lstat(from); } catch { throw new HttpError(409, "file_missing", "파일이 없어 이름을 바꿀 수 없습니다. 파일이 옮겨졌는지 확인해 주세요."); }
    if (entry.isSymbolicLink()) throw new HttpError(409, "rename_link", "링크(바로 가기)로 연 문서라 이름을 바꾸지 않습니다. 원래 파일이 있는 곳에서 바꿔 주세요.");
    if (!entry.isFile()) throw new HttpError(409, "rename_not_file", "보통 파일이 아니라 이름을 바꾸지 않습니다.");
    // Another record on this file (another project, a link to it) would be left pointing nowhere (as for the trash).
    for (const other of this.list()) {
      if (other.id === artifactId) continue;
      let twin;
      try { twin = statSync(other.path); } catch { continue; }
      if (twin.dev === entry.dev && twin.ino === entry.ino) throw new HttpError(409, "rename_shared", "다른 문서도 이 파일을 쓰고 있어 이름을 바꾸지 않습니다. 다른 프로젝트나 링크(바로 가기)로 연 같은 파일을 목록에서 뺀 뒤 바꿔 주세요.");
    }
    const taken = () => new HttpError(409, "rename_exists", `같은 폴더에 「${name}」 파일이 이미 있습니다. 다른 이름을 골라 주세요.`);
    if (this.list().some((other) => other.id !== artifactId && other.path === to)) throw taken();
    // The new name free; another entry (a file, a link, a second hard link of this file: taken); or this
    // very entry, found under a name the file system does not tell apart: decided by the folder's listing.
    let sameEntry = false;
    let target = null;
    try { target = fileOps.lstat(to); } catch { target = null; }
    if (target) {
      const two = twoEntries(from, to);
      if (two === null) throw new HttpError(409, "rename_unsure", `폴더를 읽지 못해 이름을 바꾸지 않습니다. 문서 이름은 「${oldName}」 그대로입니다.`);
      if (two || target.isSymbolicLink() || target.dev !== entry.dev || target.ino !== entry.ino) throw taken();
      sameEntry = true;
    }
    let journal: RenameJournal;
    try { journal = { from, to, mode: sameEntry ? "same-entry" : "link", ...fileIdentity(from) }; } catch { throw new HttpError(409, "file_unreadable", `파일을 읽지 못해 이름을 바꾸지 않습니다. 문서 이름은 「${oldName}」 그대로입니다.`); }
    const relativePath = artifact.relativePath ? join(dirname(artifact.relativePath), name).split(sep).join("/") : undefined;
    const moved: Artifact = { ...artifact, path: to, name, ...(relativePath ? { relativePath } : {}), updatedAt: Date.now() };
    delete moved.renaming;
    const identity = this.registry.identity(from);
    this.store.saveArtifactDurably({ ...artifact, renaming: journal });
    const cancel = () => this.store.saveArtifact(artifact);
    // Both names stay (the old one could not go, nor the new one be taken back): the journal stays, and
    // the record on the old name, so the next start settles it.
    const keep = () => {
      journal = { ...journal, held: true };
      const kept: Artifact = { ...artifact, renaming: journal };
      this.store.saveArtifactDurably(kept);
      this.artifacts.set(artifactId, kept);
    };
    const inUse = () => new HttpError(409, "rename_in_use", `다른 프로그램이 이 파일을 열고 있어 이름을 바꾸지 못했습니다. 문서 이름은 「${oldName}」 그대로입니다. 그 프로그램에서 파일을 닫은 뒤 다시 해 주세요.`);
    const failed = (error: unknown) => new HttpError(500, "rename_failed", `이름을 바꾸지 못했습니다(${(error as Error).message}). 문서 이름은 「${oldName}」 그대로입니다.`);
    const twoNames = (held: boolean) => new HttpError(409, "rename_two_names", `${held ? "다른 프로그램이 이 파일을 열고 있어 " : ""}이름을 끝까지 바꾸지 못했습니다. 지금 폴더에 「${oldName}」, 「${name}」 두 이름이 있습니다. 문서는 「${oldName}」 이름으로 그대로 쓰입니다. ${held ? "그 프로그램을 닫고 " : ""}앱을 다시 시작하면 앱이 두 이름을 확인해 정리합니다.`);
    const held = (error: unknown) => ["EBUSY", "EPERM", "EACCES"].includes(errorCode(error) ?? "");
    if (sameEntry) {
      try { fileOps.rename(from, to); } catch (error) { cancel(); throw held(error) ? inUse() : failed(error); }
      fileOps.syncDir(dir);
    } else {
      let linked = false;
      try { fileOps.link(from, to); linked = true; } catch (error) {
        if (errorCode(error) === "EEXIST") { cancel(); throw taken(); }
      }
      if (!linked) {
        // No hard links on this storage (FAT/exFAT, cloud placeholders, some network shares): an exclusive
        // copy, synced and checked against the file before the old name goes.
        journal = { ...journal, mode: "copy" };
        this.store.saveArtifactDurably({ ...artifact, renaming: journal });
        try { fileOps.copy(from, to); } catch (error) {
          cancel();
          if (errorCode(error) === "EEXIST") throw taken();
          throw new HttpError(409, "rename_unsupported", `이 저장 장치(USB 메모리, 클라우드·네트워크 폴더 등)에서는 앱이 이름을 바꿀 수 없습니다. 문서 이름은 「${oldName}」 그대로입니다.`);
        }
        let same = false;
        try { fileOps.syncFile(to); same = fileOps.lstat(to).size === journal.size && sha256(fileOps.read(to)) === journal.sha256; } catch { same = false; }
        if (!same) {
          try { fileOps.unlink(to); } catch { keep(); throw twoNames(false); }
          cancel();
          throw new HttpError(500, "rename_failed", `새 이름으로 옮긴 파일이 원래 파일과 달라 이름을 바꾸지 않았습니다. 문서 이름은 「${oldName}」 그대로입니다.`);
        }
      }
      fileOps.syncDir(dir);
      try { fileOps.unlink(from); } catch (error) {
        // The file is held (Windows: open in Word or 한글): the new name is taken back.
        try { fileOps.unlink(to); } catch { keep(); fileOps.syncDir(dir); throw twoNames(held(error)); }
        fileOps.syncDir(dir);
        cancel();
        throw held(error) ? inUse() : failed(error);
      }
      fileOps.syncDir(dir);
    }
    const done: Artifact = { ...moved, renamed: { ...journal, at: Date.now() } };
    try {
      this.store.saveArtifact(done);
    } catch (error) {
      // The record could not follow: the file goes back, so the two agree (else the journal settles it at the next start).
      try {
        this.putBack(to, from, journal);
        this.store.saveArtifact(artifact);
      } catch {
        this.artifacts.set(artifactId, { ...artifact, renaming: journal });
        throw new HttpError(500, "rename_failed", `이름을 바꾸는 중 기록을 저장하지 못했습니다(${(error as Error).message}). 파일은 「${name}」 이름에 있고, 앱을 다시 시작하면 문서가 그 이름을 따릅니다.`);
      }
      throw failed(error);
    }
    this.artifacts.set(artifactId, done);
    this.registry.moved(artifactId, identity, to);
    const former = this.formerPaths.get(artifactId) ?? new Set<string>();
    former.add(from);
    former.delete(to);
    this.formerPaths.set(artifactId, former);
    // A presentation's style file (`<name>.styleskill.json`) follows it, never over a file.
    if (artifact.format === "pptx" && !sameEntry) {
      const sidecar = (path: string) => path.replace(/\.pptx$/i, ".styleskill.json");
      try { if (!exists(sidecar(to)) && fileOps.lstat(sidecar(from)).isFile()) moveByLink(sidecar(from), sidecar(to)); } catch { /* left under the old name */ }
    }
    this.bus.publish({ type: "artifact.upserted", artifact: done });
    this.indexLatest(done);
    return { artifact: done, from };
  }

  /** The file back under its old name the way it moved (the record could not follow). */
  private putBack(to: string, from: string, journal: RenameJournal) {
    if (journal.mode === "same-entry") { fileOps.rename(to, from); return; }
    if (journal.mode === "copy") fileOps.copy(to, from);
    else fileOps.link(to, from);
    fileOps.unlink(to);
    fileOps.syncDir(dirname(from));
  }

  /** The record on `path` (the journal kept as the last finished rename when given). */
  private settledAt(artifact: Artifact, path: string, journal?: RenameJournal): Artifact {
    const next: Artifact = { ...artifact, path, name: basename(path) };
    if (artifact.relativePath) next.relativePath = join(dirname(artifact.relativePath), basename(path)).split(sep).join("/");
    delete next.renaming;
    if (journal) { const { held: _held, ...last } = journal; next.renamed = last; }
    return next;
  }

  /**
   * At start, a rename the record says was in flight: the record follows the person's file (identified
   * by what the journal recorded) to wherever it is. One directory entry under both names (letter case,
   * NFC/NFD) is never removed. Two entries on one file (linked, the old name not removed yet), or a
   * checked copy byte-identical to it, finish the move. Otherwise both files are kept and reported;
   * nothing is deleted. Also: a record on a missing name after a power cut finds the file under the
   * last rename's other name when it is that file.
   */
  private reconcileRenames() {
    for (const artifact of [...this.artifacts.values()]) {
      const next = artifact.renaming ? this.finishRename(artifact, artifact.renaming)
        : artifact.renamed && !exists(artifact.path) ? this.refindRenamed(artifact, artifact.renamed) : null;
      if (!next) continue;
      this.artifacts.set(next.id, next);
      this.store.saveArtifact(next);
    }
  }

  private finishRename(artifact: Artifact, journal: RenameJournal): Artifact {
    const { from, to } = journal;
    const label = `이름 바꾸기가 멈춘 「${artifact.name}」`;
    const atFrom = exists(from), atTo = exists(to);
    if (atFrom && atTo) {
      const two = twoEntries(from, to);
      if (two !== true) {
        // One entry under both names, or the folder unreadable: nothing is removed.
        let listed = false;
        try { listed = fileOps.readdir(dirname(to)).includes(basename(to)); } catch { listed = false; }
        return two === false && listed ? this.settledAt(artifact, to, journal) : this.settledAt(artifact, from);
      }
      const ours = { from: holdsJournalled(from, journal), to: holdsJournalled(to, journal) };
      let linked = false;
      try { const a = fileOps.lstat(from), b = fileOps.lstat(to); linked = a.dev === b.dev && a.ino === b.ino; } catch { linked = false; }
      if (journal.mode === "copy" ? ours.from && ours.to : linked && ours.to) {
        try {
          fileOps.unlink(from);
        } catch {
          this.trashReport.push(`${label}: 옛 이름을 지우지 못해 두 이름(${from}, ${to})이 그대로 있습니다. 파일을 연 프로그램을 닫고 앱을 다시 시작해 주세요.`);
          return { ...artifact, renaming: { ...journal, held: true } };
        }
        fileOps.syncDir(dirname(from));
        return this.settledAt(artifact, to, journal);
      }
      if (!journal.held && ours.to && !ours.from) {
        this.trashReport.push(`${label}: 옛 이름 자리에 다른 파일이 있어 그대로 두고, 문서는 새 이름의 파일을 따릅니다(${to}; 그대로 둔 파일 ${from}).`);
        return this.settledAt(artifact, to, journal);
      }
      this.trashReport.push(`${label}: 두 이름에 다른 파일이 있어 둘 다 두었습니다(${from}, ${to}).`);
      return this.settledAt(artifact, from);
    }
    if (atTo) return this.settledAt(artifact, to, journal);
    if (atFrom) return this.settledAt(artifact, from);
    this.trashReport.push(`${label}의 파일이 두 이름 모두에 없습니다(${from}, ${to}).`);
    return this.settledAt(artifact, from);
  }

  private refindRenamed(artifact: Artifact, last: RenameJournal): Artifact | null {
    const other = artifact.path === last.to ? last.from : artifact.path === last.from ? last.to : null;
    if (!other || !exists(other) || !holdsJournalled(other, last)) return null;
    this.trashReport.push(`이름을 바꾼 직후 컴퓨터가 꺼졌던 「${artifact.name}」 문서를 「${basename(other)}」 이름에서 다시 찾았습니다.`);
    return this.settledAt(artifact, other, last);
  }

  /** "다른 곳에 저장": a copy of a deleted project's trashed file, created exclusively; the record stays as it is. */
  saveCopy(artifactId: string, to: string) {
    const artifact = this.removedDocs.get(artifactId);
    if (!artifact?.removed?.orphaned || artifact.removed.kind !== "trash") throw new HttpError(409, "not_orphaned", "프로젝트가 지워진 문서만 다른 곳에 저장할 수 있습니다. 그 밖의 문서는 되돌리기로 돌려놓으세요.");
    copyFileSync(this.trashFile(artifactId), to, fsConstants.COPYFILE_EXCL);
    return { path: to };
  }

  /**
   * The folder of a document's revisions, to delete with it: a real folder (not a link) directly
   * inside the real `<data>/artifacts`, or null when there is none. A record's id is never trusted
   * with a recursive delete: one that leads anywhere else is refused.
   */
  private revisionsFolder(artifactId: string): string | null {
    const refusal = () => new HttpError(409, "artifact_path", "이 문서의 기록이 앱이 판을 보관하는 폴더 안의 이 문서 폴더를 가리키지 않아 아무것도 지우지 않았습니다.");
    const folder = resolve(this.root, artifactId);
    if (dirname(folder) !== resolve(this.root)) throw refusal();
    if (!exists(folder)) return null;
    const real = (path: string) => { try { return realpathSync.native(path); } catch { return null; } };
    const root = real(this.root), place = real(folder);
    if (!root || !place || !lstatSync(folder).isDirectory() || dirname(place) !== root) throw refusal();
    return place;
  }

  /** Drop a removed document's record, revisions (in `revisions`, proved by `revisionsFolder`) and proposals. */
  private forget(artifact: Artifact, revisions: string | null) {
    if (revisions) rmSync(revisions, { recursive: true, force: true });
    for (const [id, proposal] of this.proposals) if (proposal.artifactId === artifact.id) this.proposals.delete(id);
    this.removedDocs.delete(artifact.id);
    this.store.deleteArtifact(artifact.id);
    this.bus.publish({ type: "artifact.purged", artifactId: artifact.id, workId: artifact.workId });
  }

  /**
   * The folder to delete with a trashed file: this document's own (`<id>-…`), a real folder (not
   * a link) directly inside the real `<data>/trash`, or null when it, or the whole trash, is
   * already gone. A stored path is never trusted with a recursive delete: outside the trash, the
   * trash itself, deeper inside it, through a link or another document's folder, it is refused.
   */
  private trashFolder(artifactId: string, trashPath: string): string | null {
    const refusal = () => new HttpError(409, "trash_path", "이 문서의 휴지통 기록이 앱 휴지통 안에 있는 이 문서의 폴더를 가리키지 않아 아무것도 지우지 않았습니다.");
    const trash = resolve(this.dataDir, "trash");
    const folder = dirname(resolve(trashPath));
    if (!basename(folder).startsWith(`${artifactId}-`)) throw refusal();
    // The trash itself is gone (deleted by hand): nothing of the document is left to delete, when
    // its folder was, as written, directly inside it.
    if (!exists(trash)) {
      if (dirname(folder) === trash) return null;
      throw refusal();
    }
    const real = (path: string) => { try { return realpathSync.native(path); } catch { return null; } };
    const root = real(trash);
    if (!root) throw refusal();
    if (!exists(folder)) {
      if (real(dirname(folder)) === root) return null;
      throw refusal();
    }
    const place = real(folder);
    if (!place || !lstatSync(folder).isDirectory() || dirname(place) !== root) throw refusal();
    return place;
  }

  /** Delete a trashed document for good: its file in the app's trash and its revisions. Never an unlisted one. */
  purge(artifactId: string) {
    const artifact = this.removedDocs.get(artifactId);
    if (artifact?.removed?.kind !== "trash") throw new HttpError(409, "not_trashed", "앱 휴지통에 있는 문서만 영구 삭제할 수 있습니다. 목록에서 뺀 문서의 파일은 앱이 지우지 않습니다.");
    // Both places are proved before anything is deleted: a refusal deletes nothing.
    const folder = artifact.removed.trashPath ? this.trashFolder(artifact.id, artifact.removed.trashPath) : null;
    const revisions = this.revisionsFolder(artifact.id);
    if (folder) rmSync(folder, { recursive: true, force: true });
    this.forget(artifact, revisions);
  }

  /** Revisions of a removed document (kept until it is deleted for good). */
  removedRevisions(artifactId: string): ArtifactRevision[] {
    if (!this.removedDocs.has(artifactId)) throw new HttpError(404, "artifact_not_removed", "보관함에 그 문서가 없습니다.");
    return this.store.revisions(artifactId);
  }

  /** The trash copy of a removed document, for "다른 곳에 저장" by download. */
  trashFile(artifactId: string) {
    const path = this.removedDocs.get(artifactId)?.removed?.trashPath;
    if (!path || !exists(path)) throw new HttpError(404, "trash_file_missing", "휴지통에 이 문서의 파일이 없습니다.");
    return path;
  }

  /** Mark a deleted project's trashed document: it stays in 보관함 under the project's old name. */
  orphan(artifactId: string, workTitle: string) {
    const artifact = this.removedDocs.get(artifactId);
    if (!artifact?.removed) return;
    this.saveRemoved({ ...artifact, removed: { ...artifact.removed, orphaned: true, workTitle, sessionIds: [] } });
  }

  /**
   * At start, a move whose record says it was in flight is completed only when its file is in
   * exactly one of its two places (the record then says where it is); anything else is reported.
   * Nothing is ever deleted here: no record, no revision, no file. Trash files that no record
   * points at, and records whose trash file is gone, are reported too.
   */
  private reconcileTrash() {
    for (const artifact of [...this.removedDocs.values()]) {
      const removed = artifact.removed!;
      const { trashPath, pending } = removed;
      const source = removed.source ?? artifact.path;
      const done = { ...removed };
      delete done.pending;
      if (pending && trashPath) {
        const inTrash = exists(trashPath), atSource = exists(source);
        if (inTrash && !atSource) this.settle(artifact, done);
        else if (atSource && !inTrash) this.settle(artifact, null);
        else this.trashReport.push(`${pending === "moving" ? "옮기다" : "되돌리다"} 멈춘 「${artifact.name}」: 휴지통(${trashPath})과 원래 자리(${source})를 확인해 주세요.`);
      } else if (removed.kind === "trash" && trashPath && !exists(trashPath)) {
        this.trashReport.push(`「${artifact.name}」의 휴지통 파일이 없습니다: ${trashPath}`);
      }
    }
    const trash = join(this.dataDir, "trash");
    const known = new Set([...this.removedDocs.values()].flatMap((artifact) => (artifact.removed?.trashPath ? [artifact.removed.trashPath] : [])));
    let entries: string[] = [];
    try { entries = readdirSync(trash); } catch { entries = []; }
    for (const entry of entries) {
      const path = join(trash, entry);
      let names: string[];
      try { names = statSync(path).isDirectory() ? readdirSync(path).map((name) => join(path, name)) : [path]; } catch { continue; }
      for (const name of names) if (!known.has(name)) this.trashReport.push(`기록 없는 휴지통 파일: ${name}`);
    }
    for (const line of this.trashReport) console.warn(`[trash] ${line}`);
  }

  listProposals() {
    return [...this.proposals.values()];
  }

  get(artifactId: string) {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new HttpError(404, "artifact_not_found", "문서를 찾을 수 없습니다.");
    return artifact;
  }

  proposal(proposalId: string) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new HttpError(404, "proposal_not_found", "수정안을 찾을 수 없습니다.");
    return proposal;
  }

  revisions(artifactId: string): ArtifactRevision[] {
    this.get(artifactId);
    return this.store.revisions(artifactId);
  }

  /** Immutable copy of one revision. */
  revisionPath(artifactId: string, revision: number) {
    const artifact = this.get(artifactId);
    if (revision < 1 || revision > artifact.revision) throw new HttpError(404, "revision_not_found", `r${revision} 판이 없습니다.`);
    return join(this.root, artifactId, `r${revision}${extname(artifact.path)}`);
  }

  /** Mark a document as the project's own note (left out of document lists, project.ts). */
  setRole(artifactId: string, role: Artifact["role"] | null) {
    const artifact = this.get(artifactId);
    if ((artifact.role ?? null) === role) return artifact;
    const updated: Artifact = { ...artifact };
    if (role) updated.role = role;
    else delete updated.role;
    this.save(updated);
    return updated;
  }

  private save(artifact: Artifact) {
    this.artifacts.set(artifact.id, artifact);
    this.store.saveArtifact(artifact);
    this.bus.publish({ type: "artifact.upserted", artifact });
  }

  private saveProposal(proposal: Proposal) {
    this.proposals.set(proposal.id, proposal);
    this.store.saveProposal(proposal);
    this.bus.publish({ type: "proposal.upserted", proposal });
  }

  /** `index`: false when the caller indexes the new revision itself (a Hangul save that reads its view anyway). */
  private record(artifact: Artifact, data: Buffer, revision: Omit<ArtifactRevision, "artifactId" | "revision" | "sha256" | "size" | "at">, index = true) {
    const next = artifact.revision + 1;
    const copy = join(this.root, artifact.id, `r${next}${extname(artifact.path)}`);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, data);
    chmodSync(copy, 0o444);
    const entry: ArtifactRevision = { artifactId: artifact.id, revision: next, sha256: sha256(data), size: data.length, at: Date.now(), ...revision };
    this.store.saveRevision(entry);
    const updated: Artifact = { ...artifact, revision: next, sha256: entry.sha256, size: entry.size, diskState: "same", updatedAt: entry.at };
    this.save(updated);
    // Hangul and Office files are read in the background; their previous entry stays meanwhile (a new
    // one is found by its name until then, and only by it when no tool can read it).
    if (hasTextView(updated.format)) {
      if (!this.store.hasDocumentEntry(updated.id)) this.store.indexDocument(updated.id, null);
      if (index) this.textIndex.add(updated.id, updated.revision);
    } else {
      this.store.indexDocument(updated.id, searchText(updated.format, data));
    }
    if (pictured(updated.format)) this.pictures?.add(updated.id, updated.revision);
    return updated;
  }

  /**
   * A file an engine (or the user) touched: start tracking it or record a new revision when its
   * content changed. Returns what happened, or null for files that are not documents.
   */
  track(
    workId: string,
    cwd: string,
    rawPath: string,
    author: ArtifactRevision["author"],
    sessionId: string | null,
    note: string | null,
    derivedFrom: ArtifactRevision["derivedFrom"] = null,
    /** An engine's revision: the model, effort and request behind it. */
    provenance: Provenance | null = null,
  ) {
    const path = resolve(cwd, rawPath);
    const made = author === "engine" && provenance ? { model: provenance.model ?? null, effort: provenance.effort ?? null, requestId: provenance.requestId ?? null } : {};
    const format = formatOf(path);
    if (!format || isWorkbenchPath(path)) return null;
    const data = readFileOrNull(path);
    if (!data) return null;
    const identity = this.workspaces?.fileIdentity(workId, cwd, path) ?? {};
    const existing = [...this.artifacts.values()].find((artifact) => artifact.workId === workId && (
      artifact.path === path || (identity.workspaceId && artifact.workspaceId === identity.workspaceId && artifact.relativePath === identity.relativePath)
    ));
    if (existing) {
      if (sha256(data) === existing.sha256) return null;
      const updated = this.record(existing, data, { author, sessionId, baseRevision: existing.revision, note, ...(derivedFrom?.length ? { derivedFrom } : {}), ...made });
      return { artifact: updated, change: "modified" as const };
    }
    const now = Date.now();
    const artifact: Artifact = {
      id: randomUUID(),
      workId,
      ...identity,
      path,
      name: basename(path),
      format,
      revision: 0,
      sha256: "",
      size: 0,
      diskState: "same",
      readBy: {},
      createdAt: now,
      updatedAt: now,
    };
    const created = this.record(artifact, data, { author, sessionId, baseRevision: null, note, ...(derivedFrom?.length ? { derivedFrom } : {}), ...made });
    return { artifact: created, change: "created" as const };
  }

  /** Compare the disk with the latest revision (external edits, deleted files). */
  check(artifactId: string): Artifact {
    const artifact = this.get(artifactId);
    const data = readFileOrNull(artifact.path);
    const diskState = !data ? "missing" : sha256(data) === artifact.sha256 ? "same" : "changed";
    if (diskState !== artifact.diskState) {
      const updated = { ...artifact, diskState } as Artifact;
      this.save(updated);
      return updated;
    }
    return artifact;
  }

  /**
   * Text of a revision (latest by default). Binary documents expose a read-only text view;
   * the internal editor owns their edits and saves.
   */
  async text(artifactId: string, revision?: number) {
    const artifact = this.check(artifactId);
    const target = revision ?? artifact.revision;
    const text = await this.view(artifactId, target);
    return { artifact, revision: target, text, editable: !hasTextView(artifact.format) && artifact.format !== "pdf", view: hasTextView(artifact.format) };
  }

  private viewCachePath(artifact: Artifact, revision: number) {
    return join(this.root, artifact.id, `r${revision}.${isHangul(artifact.format) ? "rhwp-view-v1" : "view"}.md`);
  }

  /** The old text patcher's view remains available only for existing Markdown drafts/proposals. */
  private async legacyHangulView(artifact: Artifact, revision: number) {
    const cached = join(this.root, artifact.id, `r${revision}.view.md`), existing = readFileOrNull(cached);
    if (existing) return existing.toString("utf8");
    if (!this.kordoc?.available) throw new HttpError(501, "legacy_hangul_unavailable", "이전 글 편집 수정안을 복구할 도구가 없습니다. 원본과 수정안은 보존되어 있습니다.");
    const text = await this.kordoc.read(this.revisionPath(artifact.id, revision));
    writeFileSync(cached, text); return text;
  }

  /** Text form of a revision, using a separate cache identity for the native Hangul reader. */
  async view(artifactId: string, revision: number): Promise<string> {
    const artifact = this.get(artifactId);
    const file = this.revisionPath(artifactId, revision);
    const office = isOfficeFormat(artifact.format);
    if (!hasTextView(artifact.format)) {
      if (artifact.format === "pdf") throw new HttpError(415, "binary_document", "PDF는 텍스트로 열지 않습니다.");
      return readFileSync(file, "utf8");
    }
    const cached = this.viewCachePath(artifact, revision);
    const existing = readFileOrNull(cached);
    if (existing) return existing.toString("utf8");
    if (artifact.format === "xmind" || artifact.format === "epub") {
      const markdown = (await this.extractText(file, artifact.format))!;
      writeFileSync(cached, markdown);
      if (revision === this.get(artifactId).revision) this.store.indexDocument(artifactId, markdown);
      return markdown;
    }
    if (office) {
      if (!this.ieum?.available) throw new HttpError(501, "ieumoffice_missing", "이음오피스를 찾지 못해 이 문서의 글을 볼 수 없습니다. 앱을 다시 설치해 주세요.");
      const markdown = await this.ieum.textView(file, artifact.format as "docx" | "pptx" | "xlsx");
      writeFileSync(cached, markdown);
      if (revision === this.get(artifactId).revision) this.store.indexDocument(artifactId, markdown);
      return markdown;
    }
    const markdown = await hwpToText(readFileSync(file));
    writeFileSync(cached, markdown);
    if (revision === this.get(artifactId).revision) this.store.indexDocument(artifactId, markdown);
    return markdown;
  }

  /** Real page previews of a Hangul revision. */
  pages(artifactId: string, revision?: number) {
    const artifact = this.check(artifactId);
    if (!isHangul(artifact.format)) throw new HttpError(415, "not_hangul", "한글 문서가 아닙니다.");
    const target = revision ?? artifact.revision;
    const key = `${artifactId}:${target}`;
    let pages = this.pageCache.get(key);
    if (!pages) {
      pages = hangulPages(this.revisionPath(artifactId, target), artifact.format);
      pages.catch(() => this.pageCache.delete(key));
      this.pageCache.set(key, pages);
    }
    return pages.then((list) => ({ revision: target, pages: list }));
  }

  /** Page images of a Word/PowerPoint/Excel revision, rendered once by IeumOffice and kept. */
  officePages(artifactId: string, revision?: number) {
    const artifact = this.check(artifactId);
    if (!isOfficeFormat(artifact.format)) throw new HttpError(415, "not_office", "워드·PPT·엑셀 문서가 아닙니다.");
    const target = revision ?? artifact.revision;
    return this.renderPages(`${artifactId}:${target}`, this.revisionPath(artifactId, target), join(this.root, artifactId, `r${target}.pages`)).then((pages) => ({
      revision: target,
      pages: pages.map(({ page, width, height }) => ({ page, width, height })),
    }));
  }

  /** The PNG of one page of a revision (after `officePages`). */
  async officePagePath(artifactId: string, revision: number, page: number) {
    const artifact = this.get(artifactId);
    if (!isOfficeFormat(artifact.format)) throw new HttpError(415, "not_office", "워드·PPT·엑셀 문서가 아닙니다.");
    const pages = await this.renderPages(`${artifactId}:${revision}`, this.revisionPath(artifactId, revision), join(this.root, artifactId, `r${revision}.pages`));
    const found = pages.find((entry) => entry.page === page);
    if (!found) throw new HttpError(404, "page_not_found", `${page}쪽이 없습니다.`);
    return found.file;
  }

  /** Where a revision's first-page picture is kept: Office page 1 of `r<N>.pages`, Hangul `r<N>.cover.png`. */
  private coverFile(artifact: Artifact, revision: number) {
    return isHangul(artifact.format) ? join(this.root, artifact.id, `r${revision}.cover.png`) : join(this.root, artifact.id, `r${revision}.pages`, "pages.json");
  }

  /**
   * The first-page picture of a revision when it is already made — never made here (a tab's
   * placeholder must not wait for it, nor add a render while the editor opens). None yet: its making
   * is queued in the background and the tab shows its usual text this time.
   */
  cover(artifactId: string, revision?: number): { revision: number; cover: { page: number; width: number; height: number } | null } {
    const artifact = this.check(artifactId);
    const target = revision ?? artifact.revision;
    if (!pictured(artifact.format)) return { revision: target, cover: null };
    const found = this.coverPicture(artifact, target);
    if (!found) this.pictures?.add(artifact.id, target);
    return { revision: target, cover: found ? { page: found.page, width: found.width, height: found.height } : null };
  }

  /** The kept first-page picture of a revision (PNG), or null. */
  coverPicture(artifact: Artifact, revision: number): OfficePage | null {
    const file = this.coverFile(artifact, revision);
    try {
      if (isHangul(artifact.format)) {
        // The page as its engine drew it (SVG, with its size in CSS px beside it); a PNG only from before.
        const drawn = file.replace(/\.png$/, ".svg"), size = readFileOrNull(file.replace(/\.png$/, ".json"));
        if (size && existsSync(drawn)) {
          const page = JSON.parse(size.toString("utf8")) as { width: number; height: number };
          return { page: 1, width: page.width, height: page.height, file: drawn };
        }
        const head = readFileSync(file).subarray(0, 24);
        return { page: 1, width: head.readUInt32BE(16), height: head.readUInt32BE(20), file };
      }
      const pages = JSON.parse(readFileSync(file, "utf8")) as OfficePage[];
      const first = pages.find((entry) => entry.page === 1);
      return first && existsSync(first.file) ? first : null;
    } catch {
      return null;
    }
  }

  /** Make a revision's pictures (the background job): every page for Office (the page view uses them too), page 1 for Hangul in its own child process. */
  async makePictures(artifactId: string, revision: number) {
    const artifact = this.get(artifactId);
    if (isOfficeFormat(artifact.format)) {
      await this.renderPages(`${artifactId}:${revision}`, this.revisionPath(artifactId, revision), join(this.root, artifactId, `r${revision}.pages`));
      return;
    }
    if (!isHangul(artifact.format)) return;
    const out = this.coverFile(artifact, revision), part = `${out}.part.png`;
    const made = await hangulPicture(this.revisionPath(artifactId, revision), artifact.format, part);
    // What is kept is the page as the engine drew it (SVG): the PNG's rasterizer (resvg with the
    // messenger's fonts) drops glyphs some Hangul fonts lack (a heading's digits); the window's own
    // text drawing keeps them. The page's size in CSS px (its viewBox) goes beside it.
    const svgPart = pictureSvg(part), svg = readFileOrNull(svgPart)?.toString("utf8") ?? "";
    rmSync(part, { force: true });
    const box = /viewBox="[\d. -]+ ([\d.]+) ([\d.]+)"/.exec(svg);
    if (!svg || !box) { rmSync(svgPart, { force: true }); throw new Error(`picture ${made.ok ? "missing" : made.code}`); }
    writeFileSync(out.replace(/\.png$/, ".json"), JSON.stringify({ width: Number(box[1]), height: Number(box[2]) }));
    renameSync(svgPart, out.replace(/\.png$/, ".svg"));
  }

  /** Turn the background pictures on (the gateway does, at start). */
  enablePictures(options: Partial<PicturesOptions> = {}) {
    this.pictures = new PagePictures({
      make: (artifactId, revision) => this.makePictures(artifactId, revision),
      has: (artifactId, revision) => this.artifacts.has(artifactId) && this.coverPicture(this.get(artifactId), revision) !== null,
      current: (artifactId, revision) => this.artifacts.get(artifactId)?.revision === revision,
      busy: () => this.textIndex.active || this.rendering > 0,
      sweep: () => this.sweepPictures(),
      ...options,
    });
    return this.pictures;
  }

  /** Keep the picture cache under its bound: the oldest go, never a document's current revision. */
  sweepPictures() {
    const result = sweepPictures(this.root, this.pictureBound, (artifactId, revision) => this.artifacts.get(artifactId)?.revision === revision);
    for (const path of result.removed) {
      const match = /([^/\\]+)[/\\]r(\d+)\.pages$/.exec(path);
      if (match) this.officeCache.delete(`${match[1]}:${match[2]}`);
    }
    return result;
  }

  /** Page images of a proposal's base revision or of its working copy. */
  async proposalPages(proposalId: string, side: "base" | "proposed") {
    const proposal = this.proposal(proposalId);
    const artifact = this.get(proposal.artifactId);
    if (!isOfficeFormat(artifact.format)) throw new HttpError(415, "not_office", "워드·PPT·엑셀 문서가 아닙니다.");
    if (side === "base") return this.renderPages(`${artifact.id}:${proposal.baseRevision}`, this.revisionPath(artifact.id, proposal.baseRevision), join(this.root, artifact.id, `r${proposal.baseRevision}.pages`));
    const working = readFileOrNull(proposal.workingPath);
    if (!working) throw new HttpError(410, "proposal_missing", "수정안 사본이 사라졌습니다.");
    const digest = sha256(working).slice(0, 16);
    return this.renderPages(`${proposalId}:${digest}`, proposal.workingPath, join(this.root, artifact.id, "proposals", `${proposalId}-${digest}`));
  }

  private renderPages(key: string, input: string, folder: string): Promise<OfficePage[]> {
    let pages = this.officeCache.get(key);
    if (!pages) {
      const manifest = join(folder, "pages.json");
      const kept = readFileOrNull(manifest);
      pages = kept
        ? Promise.resolve(JSON.parse(kept.toString("utf8")) as OfficePage[])
        : (async () => {
            if (!this.ieum?.available) throw new HttpError(501, "ieumoffice_missing", "이음오피스를 찾지 못해 미리보기를 만들 수 없습니다. 앱을 다시 설치해 주세요.");
            this.rendering += 1;
            try {
              const rendered = await this.ieum.render(input, folder);
              writeFileSync(manifest, JSON.stringify(rendered));
              return rendered;
            } finally {
              this.rendering -= 1;
            }
          })();
      pages.catch(() => this.officeCache.delete(key));
      this.officeCache.set(key, pages);
      if (this.officeCache.size > 200) this.officeCache.delete(this.officeCache.keys().next().value!);
    }
    return pages;
  }

  /** New file content for an edited text: the text itself, or the HWPX patched from its Markdown view. */
  private async contentFor(artifact: Artifact, baseRevision: number, text: string): Promise<Buffer> {
    if (artifact.format === "hwp") throw new HttpError(400, "HWP_REFERENCE_ONLY", "HWP는 읽기만 합니다. HWPX로 만든 뒤 고쳐 주세요.");
    if (artifact.format === "hwpx") {
      if (!this.kordoc?.available) throw new HttpError(501, "kordoc_missing", "한글 문서 엔진(kordoc)이 없습니다.");
      return this.kordoc.patch(this.revisionPath(artifact.id, baseRevision), text);
    }
    return Buffer.from(text, "utf8");
  }

  /** The user's edit. Refuses when someone else wrote first (stale revision) or the disk changed underneath. */
  async saveText(artifactId: string, expectedRevision: number, text: string, access?: DocumentAccess) {
    this.registry.assertWrite(artifactId, access);
    const artifact = this.check(artifactId);
    if (artifact.format === "xmind" || artifact.format === "epub") throw new HttpError(415, "binary_document", "이 문서는 원본 편집기에서 저장해 주세요.");
    if (artifact.revision !== expectedRevision) {
      throw new HttpError(409, "revision_conflict", `문서가 r${artifact.revision}로 바뀌었습니다. 내 수정은 그대로 두고 비교해 주세요.`);
    }
    if (artifact.diskState === "changed") {
      throw new HttpError(409, "disk_changed", "다른 프로그램이 이 파일을 바꿨습니다. 내 수정은 그대로 두고 비교해 주세요.");
    }
    if (isHangul(artifact.format) && text === (await this.legacyHangulView(artifact, expectedRevision))) return artifact;
    if (artifact.format === "design") {
      const problem = designProblem(text);
      if (problem) throw new HttpError(422, "invalid_design", `디자인을 저장하지 않았습니다: ${problem}`);
    }
    const data = await this.contentFor(artifact, expectedRevision, text);
    if (sha256(data) === artifact.sha256) return artifact;
    const current = this.check(artifactId);
    if (current.revision !== expectedRevision || current.diskState !== "same") throw new HttpError(409, "revision_conflict", "저장하는 동안 문서가 바뀌었습니다.");
    this.registry.assertWrite(artifactId, access);
    // `current`: a rename while this save waited moved the file; it is written under its name now.
    writeAtomic(current.path, data);
    const hangul = isHangul(artifact.format);
    const saved = this.record(current, data, { author: "user", sessionId: null, baseRevision: expectedRevision, note: null }, !hangul);
    if (hangul) {
      const markdown = await this.kordoc!.read(this.revisionPath(artifactId, saved.revision));
      writeFileSync(join(this.root, artifactId, `r${saved.revision}.view.md`), markdown);
      const plain = await hwpToText(readFileSync(this.revisionPath(artifactId, saved.revision)));
      writeFileSync(this.viewCachePath(saved, saved.revision), plain);
      if (this.get(artifactId).revision === saved.revision) this.store.indexDocument(artifactId, plain);
    }
    return saved;
  }

  /**
   * Bytes an in-app editor saved (Word/PowerPoint/Excel): the next revision, refused like a text
   * save when the document moved on or the file changed on disk.
   */
  saveBytes(artifactId: string, expectedRevision: number, data: Buffer, access?: DocumentAccess) {
    this.registry.assertWrite(artifactId, access);
    const artifact = this.check(artifactId);
    if (!isOfficeFormat(artifact.format)) throw new HttpError(415, "not_office", "워드·PPT·엑셀 문서만 이렇게 저장합니다.");
    // .docx/.pptx/.xlsx are zip packages; refuse foreign bytes before changing a file.
    if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new HttpError(422, "not_office_package", "워드·PPT·엑셀 파일 형식이 아니어서 저장하지 않았습니다.");
    return this.saveEditedBytes(artifactId, expectedRevision, data, access);
  }

  /** Only the HWP codec route calls this after its save-time repairs and container validation. */
  saveHwpBytes(artifactId: string, expectedRevision: number, data: Buffer, access?: DocumentAccess) {
    if (!isHangul(this.get(artifactId).format)) throw new HttpError(415, "not_hangul", "한글 문서가 아닙니다.");
    return this.saveEditedBytes(artifactId, expectedRevision, data, access);
  }

  /** Only the PDF codec route calls this, after the original engine verifies the result. */
  savePdfBytes(artifactId: string, expectedRevision: number, data: Buffer, access?: DocumentAccess) {
    if (this.get(artifactId).format !== "pdf") throw new HttpError(415, "not_pdf", "PDF 문서가 아닙니다.");
    return this.saveEditedBytes(artifactId, expectedRevision, data, access);
  }

  /** The mindmap route validates both the source and submitted archive before calling this. */
  saveMindmapBytes(artifactId: string, expectedRevision: number, data: Buffer, access?: DocumentAccess) {
    if (this.get(artifactId).format !== "xmind") throw new HttpError(415, "not_mindmap", "마인드맵 문서가 아닙니다.");
    return this.saveEditedBytes(artifactId, expectedRevision, data, access);
  }

  /** The EPUB session prepares and validates range-saved bytes before the final CAS write. */
  saveEpubBytes(artifactId: string, expectedRevision: number, data: Buffer, access?: DocumentAccess) {
    if (this.get(artifactId).format !== "epub") throw new HttpError(415, "not_epub", "전자책 문서가 아닙니다.");
    return this.saveEditedBytes(artifactId, expectedRevision, data, access);
  }

  private saveEditedBytes(artifactId: string, expectedRevision: number, data: Buffer, access?: DocumentAccess) {
    this.registry.assertWrite(artifactId, access);
    const artifact = this.check(artifactId);
    if (artifact.revision !== expectedRevision) {
      throw new HttpError(409, "revision_conflict", `문서가 r${artifact.revision}로 바뀌었습니다(AI 수정안 적용이나 다른 편집). 최신 판을 열어 다시 고쳐 주세요.`);
    }
    if (artifact.diskState === "changed") throw new HttpError(409, "disk_changed", "다른 프로그램이 이 파일을 바꿨습니다. 최신 내용을 받은 뒤 다시 저장해 주세요.");
    if (data.length === 0) throw new HttpError(400, "empty_document", "빈 문서는 저장하지 않습니다.");
    if (sha256(data) === artifact.sha256) return artifact;
    writeAtomic(artifact.path, data);
    return this.record(artifact, data, { author: "user", sessionId: null, baseRevision: expectedRevision, note: null });
  }

  /** A Markdown note's links rewritten by the app (이름 바꾸기): a new revision, refused like any save that would overwrite a change. */
  saveLinks(artifactId: string, expectedRevision: number, text: string, note: string) {
    this.registry.assertWrite(artifactId);
    const artifact = this.check(artifactId);
    if (artifact.format !== "markdown" || artifact.revision !== expectedRevision || artifact.diskState !== "same") throw new HttpError(409, "revision_conflict", "노트가 바뀌었습니다.");
    const data = Buffer.from(text, "utf8");
    writeAtomic(artifact.path, data);
    return this.record(artifact, data, { author: "user", sessionId: null, baseRevision: expectedRevision, note });
  }

  /**
   * 한글 문서 만들기 into an EMPTY untouched open document (doc-default, 0.5.2's leftover 4d): the made HWPX
   * becomes this document's next revision (the one before it stays restorable in 판 기록). Refused like
   * any write that would overwrite a change: the revision it was decided on, the file as recorded.
   */
  fillEmpty(artifactId: string, expectedRevision: number, data: Buffer, sessionId: string | null, note: string) {
    const artifact = this.check(artifactId);
    if (artifact.format !== "hwpx") throw new HttpError(415, "hangul_format", "HWPX 문서에만 채울 수 있습니다.");
    if (artifact.revision !== expectedRevision) throw new HttpError(409, "revision_conflict", `문서가 r${artifact.revision}로 바뀌었습니다.`);
    if (artifact.diskState !== "same") throw new HttpError(409, "disk_changed", "다른 프로그램이 이 파일을 바꿨습니다.");
    if (data.length === 0) throw new HttpError(400, "empty_document", "빈 문서는 저장하지 않습니다.");
    writeAtomic(artifact.path, data);
    return this.record(artifact, data, { author: "engine", sessionId, baseRevision: expectedRevision, note, derivedFrom: [{ artifactId, revision: expectedRevision }] });
  }

  /** Keep what is on disk now as a new revision (after an external edit the user chose to keep). */
  adoptDisk(artifactId: string, note = "외부에서 바뀐 내용") {
    // Observation only: external-file watchers must record changes even while a UI owns editing.
    // This method never replaces the original; any later write still checks access and revision.
    const artifact = this.get(artifactId);
    const data = readFileOrNull(artifact.path);
    if (!data) throw new HttpError(404, "file_missing", "파일이 없습니다.");
    if (sha256(data) === artifact.sha256) return this.check(artifactId);
    return this.record(artifact, data, { author: "external", sessionId: null, baseRevision: artifact.revision, note });
  }

  /** Undo by moving forward: an older revision's content becomes a new revision. */
  revert(artifactId: string, toRevision: number, access?: DocumentAccess) {
    this.registry.assertWrite(artifactId, access);
    const artifact = this.check(artifactId);
    if (artifact.diskState === "changed") throw new HttpError(409, "disk_changed", "다른 프로그램이 이 파일을 바꿨습니다.");
    const data = readFileSync(this.revisionPath(artifactId, toRevision));
    writeAtomic(artifact.path, data);
    return this.record(artifact, data, { author: "user", sessionId: null, baseRevision: artifact.revision, note: `r${toRevision}로 되돌림` });
  }

  /** Confirm references before submission, without sending a stale saved file as live edits. */
  resolveReferences(inputs: unknown): DocRef[] {
    if (!Array.isArray(inputs) || inputs.length > 100) throw new HttpError(400, "invalid_references", "참조 문서는 한 번에 100개까지 붙일 수 있습니다.");
    return inputs.map((input) => {
      if (!input || typeof input !== "object" || typeof input.artifactId !== "string" || !["edit", "review"].includes(input.mode) || (input.savedSnapshot !== undefined && typeof input.savedSnapshot !== "boolean") || (input.sha256 !== undefined && (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)))) throw new HttpError(400, "invalid_reference", "문서 참조 형식이 올바르지 않습니다.");
      const selection = input.selection;
      if (selection != null && (typeof selection !== "object" || typeof selection.text !== "string" || typeof selection.label !== "string" || !Number.isSafeInteger(selection.from) || !Number.isSafeInteger(selection.to) || selection.from < 0 || selection.to < selection.from || (selection.pageId !== undefined && typeof selection.pageId !== "string") || (selection.objectIds !== undefined && (!Array.isArray(selection.objectIds) || selection.objectIds.length > 200 || !selection.objectIds.every((id: unknown) => typeof id === "string"))))) throw new HttpError(400, "invalid_selection", "문서 선택 범위가 올바르지 않습니다.");
      let artifact = this.get(input.artifactId);
      if (!input.savedSnapshot) {
        if (this.registry.forArtifact(artifact.id).some((view) => view.dirty)) throw new HttpError(409, "unsaved_reference", `「${artifact.name}」에 저장하지 않은 편집이 있습니다. 해당 편집기에서 저장하거나 ‘저장된 판만’을 선택해 주세요.`);
        artifact = this.adoptDisk(artifact.id);
        if (input.revision !== undefined && input.revision !== artifact.revision) throw new HttpError(409, "reference_changed", `「${artifact.name}」의 판이 바뀌었습니다. 내용을 확인한 뒤 다시 보내 주세요.`);
      }
      const revision = input.revision ?? artifact.revision;
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > artifact.revision) throw new HttpError(400, "revision_not_found", "참조할 문서 판을 찾을 수 없습니다.");
      const digest = this.revisionSha(artifact.id, revision);
      if (!digest || (input.sha256 && input.sha256 !== digest)) throw new HttpError(409, "reference_changed", "참조 문서의 해시가 일치하지 않습니다.");
      return { artifactId: artifact.id, mode: input.mode, revision, sha256: digest, ...(selection ? { selection } : {}), ...(input.savedSnapshot ? { savedSnapshot: true } : {}) };
    });
  }

  /**
   * Make the pinned revision reachable from the engine's own folder: a read-only copy, and for
   * edit requests a working copy the engine may change.
   */
  async prepare(ref: DocRef, sessionId: string, requestId: string, cwd: string) {
    const artifact = this.get(ref.artifactId);
    if (!Number.isSafeInteger(ref.revision) || ref.revision < 1 || ref.revision > artifact.revision) throw new HttpError(400, "revision_not_found", `r${ref.revision} 판이 없습니다.`);
    const digest = this.revisionSha(artifact.id, ref.revision);
    if (ref.sha256 && ref.sha256 !== digest) throw new HttpError(409, "reference_changed", "참조 문서의 해시가 일치하지 않습니다.");
    if (ref.mode === "edit" && (artifact.format === "pdf" || artifact.format === "xmind" || artifact.format === "epub")) {
      throw new HttpError(400, "not_editable", `${artifact.format.toUpperCase()}는 AI 수정안을 만들 수 없습니다. 검토 요청으로 보내 주세요.`);
    }
    const office = isOfficeFormat(artifact.format);
    if (ref.mode === "edit" && office && !this.ieum?.available) {
      throw new HttpError(400, "ieumoffice_missing", "이음오피스를 찾지 못해 워드·PPT·엑셀 수정 요청을 보낼 수 없습니다. 앱을 다시 설치해 주세요.");
    }
    const hangul = isHangul(artifact.format);
    const source = this.revisionPath(artifact.id, ref.revision);
    if (!digest || sha256(readFileSync(source)) !== digest) throw new HttpError(409, "revision_damaged", "문서 판의 내용과 기록된 해시가 다릅니다. 원본을 확인해 주세요.");
    const extension = extensionOf(artifact);
    const stem = artifact.format === "design" ? designStem(artifact.name) : basename(artifact.name, extension);
    const pinnedDir = join(cwd, WORKBENCH_DIR, "pinned");
    mkdirSync(pinnedDir, { recursive: true });
    // Names alone are not identity: two folders can contain different files with the same name.
    const pinStem = `${Array.from(stem).slice(0, 32).join("")}.${artifact.id}.r${ref.revision}.${digest.slice(0, 16)}`;
    const pinned = join(pinnedDir, `${pinStem}${extension}`);
    if (!existsSync(pinned)) {
      copyFileSync(source, pinned);
      chmodSync(pinned, 0o444);
    }
    if (sha256(readFileSync(pinned)) !== digest) throw new HttpError(409, "pinned_copy_changed", "참조 사본이 변경되어 요청을 보내지 않았습니다. 원래 문서 판은 보존되어 있습니다.");
    // Readable text is a separate immutable reference. Edits always target the binary copy.
    let pinnedView: string | null = null;
    if (office && this.ieum?.available) {
      pinnedView = join(pinnedDir, `${pinStem}${extension}.md`);
      if (!existsSync(pinnedView)) {
        writeFileSync(pinnedView, await this.view(artifact.id, ref.revision));
        chmodSync(pinnedView, 0o444);
      }
    }
    if (hangul || artifact.format === "xmind" || artifact.format === "epub") {
      pinnedView = join(pinnedDir, `${pinStem}${extension}.md`);
      if (!existsSync(pinnedView)) {
        writeFileSync(pinnedView, await this.view(artifact.id, ref.revision));
        chmodSync(pinnedView, 0o444);
      }
    }
    let proposal: Proposal | null = null;
    if (ref.mode === "edit") {
      const busy = [...this.proposals.values()].find(
        (entry) => entry.artifactId === artifact.id && entry.status === "running" && entry.sessionId !== sessionId,
      );
      if (busy) throw new HttpError(409, "artifact_busy", "다른 세션이 이 문서의 수정안을 만드는 중입니다. 검토 요청으로 보내 주세요.");
      const draftDir = join(cwd, WORKBENCH_DIR, "drafts");
      mkdirSync(draftDir, { recursive: true });
      const workingPath = join(draftDir, `${pinStem}.${sha256(requestId).slice(0, 32)}${extension}`);
      copyFileSync(source, workingPath);
      chmodSync(workingPath, 0o644);
      const now = Date.now();
      proposal = {
        id: randomUUID(),
        artifactId: artifact.id,
        sessionId,
        requestId,
        baseRevision: ref.revision,
        workingPath,
        status: "running",
        added: 0,
        removed: 0,
        appliedRevision: null,
        createdAt: now,
        updatedAt: now,
      };
      this.saveProposal(proposal);
    }
    this.save({ ...this.get(artifact.id), readBy: { ...this.get(artifact.id).readBy, [sessionId]: ref.revision } });
    return { artifact, pinned, pinnedView, proposal };
  }

  summary(ref: DocRef): RefSummary {
    const artifact = this.get(ref.artifactId);
    return { artifactId: artifact.id, name: artifact.name, revision: ref.revision, mode: ref.mode, selection: ref.selection?.label ?? null, sha256: this.revisionSha(artifact.id, ref.revision), ...(ref.savedSnapshot ? { savedSnapshot: true } : {}) };
  }

  /**
   * The engine's turn is over: whatever is in the working copy becomes the proposal — also when the
   * turn was cut short (`interruptedBy`: stopped, failed, its engine died, the app restarted), then
   * marked as part of a turn that did not finish. Reviewed and applied or discarded like any other.
   */
  finishProposal(proposalId: string, end: { interruptedBy?: TurnBreak | null; model?: string | null; effort?: string | null } = {}) {
    const proposal = this.proposal(proposalId);
    if (proposal.status !== "running") return proposal;
    const made = { ...(end.model !== undefined ? { model: end.model } : {}), ...(end.effort !== undefined ? { effort: end.effort } : {}) };
    const artifact = this.get(proposal.artifactId);
    const base = legacyHangulProposal(artifact, proposal)
      ? readFileOrNull(join(this.root, artifact.id, `r${proposal.baseRevision}.view.md`))
      : readFileOrNull(this.revisionPath(proposal.artifactId, proposal.baseRevision));
    const working = readFileOrNull(proposal.workingPath);
    const now = Date.now();
    if (!base || !working || sha256(base) === sha256(working)) {
      const empty: Proposal = { ...proposal, ...made, status: "empty", closedBy: end.interruptedBy ?? "turn", updatedAt: now };
      this.saveProposal(empty);
      return empty;
    }
    const office = isOfficeFormat(artifact.format);
    const binaryHangul = isHangul(artifact.format) && !legacyHangulProposal(artifact, proposal);
    const counts = office || binaryHangul ? { added: 0, removed: 0 } : countChanges(base.toString("utf8"), working.toString("utf8"));
    const problem = artifact.format === "design" ? designProblem(working.toString("utf8")) : null;
    const pending: Proposal = { ...proposal, ...counts, ...made, problem, ...(end.interruptedBy ? { interruptedBy: end.interruptedBy } : {}), status: "pending", updatedAt: now };
    this.saveProposal(pending);
    if (office) void this.checkOffice(pending.id);
    if (binaryHangul) void this.checkHangul(pending.id);
    return pending;
  }

  /** Why a new document cannot be opened by its editor engine, or null. */
  async newDocumentProblem(path: string): Promise<string | null> {
    const format = formatOf(path);
    if (format === "design") return designProblem(readFileOrNull(path)?.toString("utf8") ?? "");
    if (format && isOfficeFormat(format)) return this.officeProblem(path);
    if (format && isHangul(format)) {
      try {
        const bytes = readFileSync(path);
        await openHwpBytes(bytes, hwpFormat(format));
        await hwpToText(bytes);
        return null;
      } catch (error) {
        return `한글 엔진이 이 파일을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return null;
  }

  /** A Word/PowerPoint/Excel working copy must still open; otherwise the proposal says why and is not applied. */
  private async checkOffice(proposalId: string) {
    const proposal = this.proposal(proposalId);
    const problem = await this.officeProblem(proposal.workingPath);
    if (problem && this.proposal(proposalId).status === "pending") this.saveProposal({ ...this.proposal(proposalId), problem, updatedAt: Date.now() });
  }

  private async checkHangul(proposalId: string) {
    const proposal = this.proposal(proposalId), artifact = this.get(proposal.artifactId);
    const original = readFileOrNull(this.revisionPath(artifact.id, proposal.baseRevision)), working = readFileOrNull(proposal.workingPath);
    let problem: string | null = null, counts = { added: 0, removed: 0 }, removedStructure: string[] | null = null;
    try {
      if (!original || !working) throw new Error("수정안 사본이 없습니다.");
      const format = hwpFormat(artifact.format);
      await prepareHwpSave(original, working, format, {});
      counts = countChanges(await hwpToText(original), await hwpToText(working));
      // Information, not a refusal: the AI may delete on request, the person decides before applying.
      const census = async (bytes: Uint8Array) => withHwpDocument((await openHwpBytes(bytes, format)).bytes, hwpStructureOf);
      removedStructure = lostStructure(await census(original), await census(working));
    } catch (error) { problem = `한글 수정안을 적용할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`; }
    const latest = this.proposal(proposalId), nowBytes = readFileOrNull(proposal.workingPath);
    if (latest.status === "pending" && working && nowBytes && sha256(working) === sha256(nowBytes)) this.saveProposal({ ...latest, ...counts, problem, removedStructure, updatedAt: Date.now() });
  }

  private async officeProblem(path: string): Promise<string | null> {
    if (!this.ieum?.available) return null;
    try {
      await this.ieum.run(["info", path], [dirname(path)], 60_000);
      return null;
    } catch (error) {
      return `이음오피스가 이 파일을 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Proposals whose turn is still running (of one session, or all). */
  runningProposals(sessionId?: string) {
    return [...this.proposals.values()].filter((proposal) => proposal.status === "running" && (sessionId === undefined || proposal.sessionId === sessionId));
  }

  /** Base, proposal and current text, for the preview. */
  async proposalTexts(proposalId: string) {
    const proposal = this.proposal(proposalId);
    const artifact = this.check(proposal.artifactId);
    return {
      proposal,
      artifact,
      base: legacyHangulProposal(artifact, proposal) ? await this.legacyHangulView(artifact, proposal.baseRevision) : await this.view(artifact.id, proposal.baseRevision),
      proposed: isOfficeFormat(artifact.format)
        ? existsSync(proposal.workingPath) && this.ieum?.available
          ? await this.ieum.textView(proposal.workingPath, artifact.format as "docx" | "pptx" | "xlsx")
          : ""
        : isHangul(artifact.format) && !legacyHangulProposal(artifact, proposal)
          ? await hwpToText(readFileSync(proposal.workingPath))
          : (readFileOrNull(proposal.workingPath)?.toString("utf8") ?? ""),
      current: legacyHangulProposal(artifact, proposal) ? await this.legacyHangulView(artifact, artifact.revision) : await this.view(artifact.id, artifact.revision),
    };
  }

  /**
   * Apply only onto the revision the proposal was made from. A proposal made on r3 is never
   * written over r4: the user compares or asks again on the latest revision.
   */
  async applyProposal(proposalId: string, access?: DocumentAccess) {
    const proposal = this.proposal(proposalId);
    this.registry.assertWrite(proposal.artifactId, access);
    if (proposal.status !== "pending") throw new HttpError(409, "proposal_not_pending", "이미 처리된 수정안입니다.");
    const artifact = this.check(proposal.artifactId);
    if (artifact.revision !== proposal.baseRevision) {
      throw new HttpError(
        409,
        "stale_proposal",
        `이 수정안은 r${proposal.baseRevision} 기준인데 문서는 지금 r${artifact.revision}입니다. 자동으로 적용하지 않습니다.`,
      );
    }
    if (artifact.diskState !== "same") throw new HttpError(409, "disk_changed", "다른 프로그램이 이 파일을 바꿨습니다.");
    const working = readFileOrNull(proposal.workingPath);
    if (!working) throw new HttpError(410, "proposal_missing", "수정안 사본이 사라졌습니다.");
    if (artifact.format === "design") {
      const problem = designProblem(working.toString("utf8"));
      if (problem) throw new HttpError(422, "invalid_design", `이 수정안은 디자인 파일로 열 수 없어 적용하지 않습니다: ${problem}`);
    }
    if (isOfficeFormat(artifact.format)) {
      const problem = await this.officeProblem(proposal.workingPath);
      if (problem) throw new HttpError(422, "invalid_document", `이 수정안은 적용하지 않습니다. ${problem}`);
    }
    const data = legacyHangulProposal(artifact, proposal)
      ? await this.contentFor(artifact, proposal.baseRevision, working.toString("utf8"))
      : isHangul(artifact.format)
        ? await prepareHwpSave(readFileSync(this.revisionPath(artifact.id, proposal.baseRevision)), working, hwpFormat(artifact.format), {})
        : working;
    const latest = this.check(artifact.id);
    if (latest.revision !== proposal.baseRevision || latest.diskState !== "same") throw new HttpError(409, "stale_proposal", "적용하는 동안 문서가 바뀌었습니다.");
    this.registry.assertWrite(artifact.id, access);
    writeAtomic(artifact.path, data);
    const updated = this.record(artifact, data, {
      author: "engine",
      sessionId: proposal.sessionId,
      baseRevision: proposal.baseRevision,
      note: proposal.interruptedBy ? "중단된 턴의 일부 수정안 적용" : "수정안 적용",
      model: proposal.model ?? null,
      effort: proposal.effort ?? null,
      requestId: proposal.requestId,
    });
    const applied: Proposal = { ...proposal, status: "applied", appliedRevision: updated.revision, closedBy: "user", updatedAt: Date.now() };
    this.saveProposal(applied);
    return { proposal: applied, artifact: updated };
  }

  /** `closedBy`: the user, unless the request never reached the engine ("failure"). */
  discardProposal(proposalId: string, closedBy: ProposalCloser = "user") {
    const proposal = this.proposal(proposalId);
    if (proposal.status !== "pending" && proposal.status !== "running") return proposal;
    const discarded: Proposal = { ...proposal, status: "discarded", closedBy, updatedAt: Date.now() };
    this.saveProposal(discarded);
    return discarded;
  }

  /** Engine instructions for one pinned document. */
  promptFor(ref: DocRef, pinned: string, proposal: Proposal | null, cwd: string, pinnedView: string | null = null) {
    const artifact = this.get(ref.artifactId);
    const show = (path: string) => {
      const inside = relative(cwd, path);
      return inside && !inside.startsWith("..") && !inside.startsWith(sep) ? inside : path;
    };
    const lines = [`- 「${artifact.name}」 (${artifact.format}) 판 r${ref.revision} · sha256 ${this.revisionSha(artifact.id, ref.revision)}`];
    if (ref.savedSnapshot) lines.push("  · 사용자가 고른 저장된 판입니다. 열린 편집기의 미저장 내용은 포함하지 않습니다.");
    lines.push(`  · 이 판의 읽기 전용 사본: ${show(pinned)}`);
    if (pinnedView) lines.push(`  · 같은 판의 Markdown 보기(문서 내용, 읽기 전용): ${show(pinnedView)}`);
    if (proposal && legacyHangulProposal(artifact, proposal)) {
      lines.push(`  · 고칠 때는 이 Markdown 작업 사본만 수정하세요: ${show(proposal.workingPath)}`);
      lines.push("    문단·표 칸의 글자만 바꾸세요. 문단을 새로 만들거나 지우거나 순서를 바꾸면 HWPX에 반영되지 않습니다. 원본 HWPX는 직접 고치지 마세요.");
    } else if (proposal) {
      lines.push(`  · 고칠 때는 이 작업 사본만 수정하세요: ${show(proposal.workingPath)}`);
      lines.push(`    원본 파일(${show(artifact.path)})은 직접 고치지 마세요. 앱이 사본의 변경을 수정안으로 보여 주고 사용자가 적용합니다.`);
    } else {
      lines.push("  · 이 판을 읽고 답하세요. 파일은 고치지 마세요.");
    }
    if (artifact.format === "design") {
      const source = proposal ? proposal.workingPath : pinned;
      lines.push(...designGuide(readFileOrNull(source)?.toString("utf8") ?? null, artifact.path));
    }
    if (isOfficeFormat(artifact.format)) lines.push(...this.officeGuide(artifact.format as "docx" | "pptx" | "xlsx", proposal ? show(proposal.workingPath) : null, pinnedView ? show(pinnedView) : null));
    if (isHangul(artifact.format) && !(proposal && legacyHangulProposal(artifact, proposal))) {
      lines.push("  · 한글 도구: `workbench-hwp catalog`로 원본 편집기의 본문·표·서식·필드·각주 명령과 정확한 JSON schema를 확인하세요.");
      lines.push("    읽기: `workbench-hwp read <파일> --full`. 압축/XML을 직접 고치거나 전체 문서를 텍스트로 다시 만들지 마세요.");
      if (proposal) lines.push(`    수정 명령: workbench-hwp apply ${JSON.stringify(show(proposal.workingPath))} --ops <ops.json> (먼저 --dry-run 가능). 명령은 작업 사본만 저장합니다. 원본은 사용자가 수정안을 적용할 때만 바뀝니다.`);
    }
    if (ref.selection) {
      lines.push(`  · 선택 범위(${ref.selection.label}):`);
      if (ref.selection.objectIds?.length) lines.push(`    페이지 id ${ref.selection.pageId ?? "?"}, 개체 id ${ref.selection.objectIds.join(", ")}`);
      for (const line of ref.selection.text.slice(0, 4000).split("\n")) lines.push(`    > ${line}`);
      if (proposal) lines.push("    요청은 이 범위를 대상으로 합니다. 범위 밖은 바꾸지 마세요.");
    }
    return lines.join("\n");
  }

  /** How an engine works on a Word/PowerPoint/Excel file: the ieumoffice tool, never unzip and edit XML. */
  private officeGuide(format: "docx" | "pptx" | "xlsx", working: string | null, textView: string | null) {
    const cli = this.ieum?.available ? this.ieum.engineCommand : null;
    const group = format === "docx" ? "docs" : format === "pptx" ? "slides" : "sheet";
    const guide = format === "docx" ? "docs" : format === "pptx" ? "slides" : "sheets";
    const lines = [`  · 이 문서는 ${format.toUpperCase()} 파일입니다. 압축을 풀거나 XML을 직접 고치지 말고 이음오피스 명령줄 도구를 쓰세요.`];
    if (textView) lines.push(`    글 보기(읽기 전용, 빠른 참고용): ${textView}`);
    if (!cli) {
      lines.push("    이음오피스를 찾지 못해 이번에는 읽기만 할 수 있습니다.");
      return lines;
    }
    lines.push(`    도구: ${cli}  (사용법: \`${cli} guide ${guide}\`${this.ieum?.skillPath() ? `, 자세한 안내: ${this.ieum.skillPath()}` : ""})`);
    lines.push(`    읽기: \`${cli} ${group} read <파일>${format === "pptx" ? " --full" : ""}\``);
    if (working) {
      lines.push(`    고치기: \`${cli} ${group} apply ${working} ${format === "xlsx" ? "--ops <ops.json>" : "--ops <ops.json>"}\` (먼저 --dry-run 가능), 끝나면 \`${cli} ${format === "pptx" ? "slides audit" : `${group} check`} ${working}\`로 확인하세요.`);
      lines.push(`    쪽 그림으로 확인: \`${cli} render ${working} --out <폴더>\``);
    }
    return lines;
  }

  private revisionSha(artifactId: string, revision: number) {
    return this.store.revisions(artifactId).find((entry) => entry.revision === revision)?.sha256 ?? "";
  }

  /** Keep an image the user put into a design next to the design file. */
  saveAsset(artifactId: string, data: Buffer, contentType: string, name: string, access?: DocumentAccess) {
    const artifact = this.get(artifactId);
    if (artifact.format !== "design") throw new HttpError(400, "not_design", "디자인 문서가 아닙니다.");
    this.registry.assertWrite(artifactId, access);
    return { src: saveDesignAsset(artifact.path, data, contentType, name) };
  }

  /** Recovery and copies remain available to a registered view after it loses write ownership. */
  designView(artifactId: string, access?: DocumentAccess) {
    const artifact = this.get(artifactId);
    if (artifact.format !== "design") throw new HttpError(400, "not_design", "디자인 문서가 아닙니다.");
    const view = access && this.registry.forArtifact(artifactId).find((entry) => entry.viewId === access.viewId && entry.artifactId === artifactId);
    if (!view) throw new HttpError(423, "design_view_missing", "디자인 창의 연결을 확인하지 못했습니다. 문서를 다시 열어 주세요.");
    return view;
  }

  /** File behind an image src of a design (relative to the design's folder). */
  assetPath(artifactId: string, src: string) {
    const artifact = this.get(artifactId);
    if (artifact.format !== "design") throw new HttpError(400, "not_design", "디자인 문서가 아닙니다.");
    return designAssetPath(artifact.path, src);
  }

  stat(artifactId: string) {
    const artifact = this.get(artifactId);
    try {
      return statSync(artifact.path);
    } catch {
      return null;
    }
  }
}
