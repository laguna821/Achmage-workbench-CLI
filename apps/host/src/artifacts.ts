import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { diffLines } from "diff";
import { DESIGN_EXTENSION, formatOf, isOfficeFormat, type Artifact, type ArtifactRevision, type DocRef, type Proposal, type RefSummary } from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";
import type { Kordoc } from "./kordoc.ts";
import { designAssetPath, designGuide, designProblem, designStem, saveDesignAsset } from "./design.ts";
import type { IeumOffice, OfficePage } from "./ieumoffice.ts";

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

/** Write next to the target, then rename, so a crash never leaves half a file. */
function writeAtomic(path: string, data: Buffer | string) {
  const temporary = `${path}.workbench-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

const isHangul = (format: string) => format === "hwpx" || format === "hwp";

/** Extension kept on copies of a document (designs keep their two-part `.design.json`). */
const extensionOf = (artifact: Pick<Artifact, "format" | "name">) => (artifact.format === "design" ? DESIGN_EXTENSION : extname(artifact.name));

export function isWorkbenchPath(path: string) {
  return path.split(/[\\/]/).includes(WORKBENCH_DIR);
}

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

/** Bumped when what the document index holds changes; documents are then indexed again once. */
const DOCUMENT_SEARCH_VERSION = "1";

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
  private readonly artifacts = new Map<string, Artifact>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly root: string;
  readonly kordoc: Kordoc | null;
  /** Word/PowerPoint/Excel engine; replaced when IeumOffice is installed while the gateway runs. */
  ieum: IeumOffice | null;
  private readonly pageCache = new Map<string, Promise<import("./kordoc.ts").HangulPage[]>>();
  private readonly officeCache = new Map<string, Promise<OfficePage[]>>();

  constructor(store: Store, bus: EventBus, dataDir: string, kordoc: Kordoc | null = null, ieum: IeumOffice | null = null) {
    this.store = store;
    this.bus = bus;
    this.root = join(dataDir, "artifacts");
    this.kordoc = kordoc;
    this.ieum = ieum;
    for (const artifact of store.artifacts()) this.artifacts.set(artifact.id, { ...artifact, readBy: artifact.readBy ?? {} });
    for (const proposal of store.proposals()) {
      // A turn cut short by a restart never finished its working copy; judge it now.
      this.proposals.set(proposal.id, proposal);
      if (proposal.status === "running") this.finishProposal(proposal.id);
    }
    if (store.getMeta("search.documents") !== DOCUMENT_SEARCH_VERSION) {
      for (const artifact of this.artifacts.values()) this.indexLatest(artifact);
      store.setMeta("search.documents", DOCUMENT_SEARCH_VERSION);
    }
  }

  /**
   * Keep the search index on a document's latest revision: text formats as they are, Hangul and
   * Office files through their text view once one was made (opening "글 보기" makes it).
   */
  private indexLatest(artifact: Artifact) {
    if (artifact.revision < 1) return;
    try {
      const copy = join(this.root, artifact.id, `r${artifact.revision}${extname(artifact.path)}`);
      const data = readFileOrNull(copy);
      let text = data ? searchText(artifact.format, data) : null;
      if (text === null && (isHangul(artifact.format) || isOfficeFormat(artifact.format))) {
        text = readFileOrNull(join(this.root, artifact.id, `r${artifact.revision}.view.md`))?.toString("utf8") ?? null;
      }
      this.store.indexDocument(artifact.id, text);
    } catch {
      // Search is a convenience: a document that cannot be read now is found again after its next change.
    }
  }

  list() {
    return [...this.artifacts.values()];
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

  private record(artifact: Artifact, data: Buffer, revision: Omit<ArtifactRevision, "artifactId" | "revision" | "sha256" | "size" | "at">) {
    const next = artifact.revision + 1;
    const copy = join(this.root, artifact.id, `r${next}${extname(artifact.path)}`);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, data);
    chmodSync(copy, 0o444);
    const entry: ArtifactRevision = { artifactId: artifact.id, revision: next, sha256: sha256(data), size: data.length, at: Date.now(), ...revision };
    this.store.saveRevision(entry);
    const updated: Artifact = { ...artifact, revision: next, sha256: entry.sha256, size: entry.size, diskState: "same", updatedAt: entry.at };
    this.save(updated);
    this.store.indexDocument(updated.id, searchText(updated.format, data));
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
  ) {
    const path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    const format = formatOf(path);
    if (!format || isWorkbenchPath(path)) return null;
    const data = readFileOrNull(path);
    if (!data) return null;
    const existing = [...this.artifacts.values()].find((artifact) => artifact.workId === workId && artifact.path === path);
    if (existing) {
      if (sha256(data) === existing.sha256) return null;
      const updated = this.record(existing, data, { author, sessionId, baseRevision: existing.revision, note, ...(derivedFrom?.length ? { derivedFrom } : {}) });
      return { artifact: updated, change: "modified" as const };
    }
    const now = Date.now();
    const artifact: Artifact = {
      id: randomUUID(),
      workId,
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
    const created = this.record(artifact, data, { author, sessionId, baseRevision: null, note, ...(derivedFrom?.length ? { derivedFrom } : {}) });
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
   * Editable text of a revision (latest by default). Hangul documents are shown as their Markdown
   * view from the kordoc engine; HWP stays read only.
   */
  async text(artifactId: string, revision?: number) {
    const artifact = this.check(artifactId);
    const target = revision ?? artifact.revision;
    const text = await this.view(artifactId, target);
    const office = isOfficeFormat(artifact.format);
    return { artifact, revision: target, text, editable: artifact.format !== "hwp" && artifact.format !== "pdf" && !office, view: isHangul(artifact.format) || office };
  }

  /** Text form of a revision: the file itself, or the cached kordoc Markdown view for Hangul files. */
  async view(artifactId: string, revision: number): Promise<string> {
    const artifact = this.get(artifactId);
    const file = this.revisionPath(artifactId, revision);
    const office = isOfficeFormat(artifact.format);
    if (!isHangul(artifact.format) && !office) {
      if (artifact.format === "pdf") throw new HttpError(415, "binary_document", "PDF는 텍스트로 열지 않습니다.");
      return readFileSync(file, "utf8");
    }
    const cached = join(this.root, artifactId, `r${revision}.view.md`);
    const existing = readFileOrNull(cached);
    if (existing) return existing.toString("utf8");
    if (office) {
      if (!this.ieum?.available) throw new HttpError(501, "ieumoffice_missing", "이음오피스가 없어 이 문서의 글을 볼 수 없습니다. 연결 설정에서 설치하세요.");
      const markdown = await this.ieum.textView(file, artifact.format as "docx" | "pptx" | "xlsx");
      writeFileSync(cached, markdown);
      if (revision === this.get(artifactId).revision) this.store.indexDocument(artifactId, markdown);
      return markdown;
    }
    if (!this.kordoc?.available) throw new HttpError(501, "kordoc_missing", "한글 문서 엔진(kordoc)이 없어 이 문서를 텍스트로 볼 수 없습니다.");
    const markdown = await this.kordoc.read(file);
    writeFileSync(cached, markdown);
    if (revision === this.get(artifactId).revision) this.store.indexDocument(artifactId, markdown);
    return markdown;
  }

  /** Real page previews of a Hangul revision. */
  pages(artifactId: string, revision?: number) {
    const artifact = this.check(artifactId);
    if (!isHangul(artifact.format)) throw new HttpError(415, "not_hangul", "한글 문서가 아닙니다.");
    if (!this.kordoc?.available) throw new HttpError(501, "kordoc_missing", "한글 문서 엔진(kordoc)이 없습니다.");
    const target = revision ?? artifact.revision;
    const key = `${artifactId}:${target}`;
    let pages = this.pageCache.get(key);
    if (!pages) {
      pages = this.kordoc.render(this.revisionPath(artifactId, target));
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
            if (!this.ieum?.available) throw new HttpError(501, "ieumoffice_missing", "이음오피스가 없어 미리보기를 만들 수 없습니다. 연결 설정에서 설치하세요.");
            const rendered = await this.ieum.render(input, folder);
            writeFileSync(manifest, JSON.stringify(rendered));
            return rendered;
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
  async saveText(artifactId: string, expectedRevision: number, text: string) {
    const artifact = this.check(artifactId);
    if (artifact.revision !== expectedRevision) {
      throw new HttpError(409, "revision_conflict", `문서가 r${artifact.revision}로 바뀌었습니다. 내 수정은 그대로 두고 비교해 주세요.`);
    }
    if (artifact.diskState === "changed") {
      throw new HttpError(409, "disk_changed", "다른 프로그램이 이 파일을 바꿨습니다. 내 수정은 그대로 두고 비교해 주세요.");
    }
    if (isHangul(artifact.format) && text === (await this.view(artifactId, expectedRevision))) return artifact;
    if (artifact.format === "design") {
      const problem = designProblem(text);
      if (problem) throw new HttpError(422, "invalid_design", `디자인을 저장하지 않았습니다: ${problem}`);
    }
    const data = await this.contentFor(artifact, expectedRevision, text);
    if (sha256(data) === artifact.sha256) return artifact;
    const current = this.check(artifactId);
    if (current.revision !== expectedRevision || current.diskState !== "same") throw new HttpError(409, "revision_conflict", "저장하는 동안 문서가 바뀌었습니다.");
    writeAtomic(artifact.path, data);
    const saved = this.record(current, data, { author: "user", sessionId: null, baseRevision: expectedRevision, note: null });
    if (isHangul(artifact.format)) writeFileSync(join(this.root, artifactId, `r${saved.revision}.view.md`), await this.kordoc!.read(this.revisionPath(artifactId, saved.revision)));
    return saved;
  }

  /**
   * Bytes an in-app editor saved (Word/PowerPoint/Excel): the next revision, refused like a text
   * save when the document moved on or the file changed on disk.
   */
  saveBytes(artifactId: string, expectedRevision: number, data: Buffer) {
    const artifact = this.check(artifactId);
    if (!isOfficeFormat(artifact.format)) throw new HttpError(415, "not_office", "워드·PPT·엑셀 문서만 이렇게 저장합니다.");
    if (artifact.revision !== expectedRevision) {
      throw new HttpError(409, "revision_conflict", `문서가 r${artifact.revision}로 바뀌었습니다(AI 수정안 적용이나 다른 편집). 최신 판을 열어 다시 고쳐 주세요.`);
    }
    if (artifact.diskState === "changed") throw new HttpError(409, "disk_changed", "다른 프로그램이 이 파일을 바꿨습니다. 최신 내용을 받은 뒤 다시 저장해 주세요.");
    if (data.length === 0) throw new HttpError(400, "empty_document", "빈 문서는 저장하지 않습니다.");
    // .docx/.pptx/.xlsx are zip packages; anything else (a password-protected file, a broken save) is refused.
    if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new HttpError(422, "not_office_package", "워드·PPT·엑셀 파일 형식이 아니어서 저장하지 않았습니다.");
    if (sha256(data) === artifact.sha256) return artifact;
    writeAtomic(artifact.path, data);
    return this.record(artifact, data, { author: "user", sessionId: null, baseRevision: expectedRevision, note: null });
  }

  /** Keep what is on disk now as a new revision (after an external edit the user chose to keep). */
  adoptDisk(artifactId: string, note = "외부에서 바뀐 내용") {
    const artifact = this.get(artifactId);
    const data = readFileOrNull(artifact.path);
    if (!data) throw new HttpError(404, "file_missing", "파일이 없습니다.");
    if (sha256(data) === artifact.sha256) return this.check(artifactId);
    return this.record(artifact, data, { author: "external", sessionId: null, baseRevision: artifact.revision, note });
  }

  /** Undo by moving forward: an older revision's content becomes a new revision. */
  revert(artifactId: string, toRevision: number) {
    const artifact = this.check(artifactId);
    if (artifact.diskState === "changed") throw new HttpError(409, "disk_changed", "다른 프로그램이 이 파일을 바꿨습니다.");
    const data = readFileSync(this.revisionPath(artifactId, toRevision));
    writeAtomic(artifact.path, data);
    return this.record(artifact, data, { author: "user", sessionId: null, baseRevision: artifact.revision, note: `r${toRevision}로 되돌림` });
  }

  /**
   * Make the pinned revision reachable from the engine's own folder: a read-only copy, and for
   * edit requests a working copy the engine may change.
   */
  async prepare(ref: DocRef, sessionId: string, requestId: string, cwd: string) {
    const artifact = this.get(ref.artifactId);
    if (ref.revision < 1 || ref.revision > artifact.revision) throw new HttpError(400, "revision_not_found", `r${ref.revision} 판이 없습니다.`);
    if (ref.mode === "edit" && (artifact.format === "hwp" || artifact.format === "pdf")) {
      throw new HttpError(400, "not_editable", `${artifact.format.toUpperCase()}는 AI 수정안을 만들 수 없습니다. 검토 요청으로 보내 주세요.`);
    }
    const office = isOfficeFormat(artifact.format);
    if (ref.mode === "edit" && office && !this.ieum?.available) {
      throw new HttpError(400, "ieumoffice_missing", "워드·PPT·엑셀 수정 요청에는 이음오피스가 필요합니다. 연결 설정에서 설치하세요.");
    }
    const hangul = isHangul(artifact.format);
    const source = this.revisionPath(artifact.id, ref.revision);
    const extension = extensionOf(artifact);
    const stem = artifact.format === "design" ? designStem(artifact.name) : basename(artifact.name, extension);
    const pinnedDir = join(cwd, WORKBENCH_DIR, "pinned");
    mkdirSync(pinnedDir, { recursive: true });
    const pinned = join(pinnedDir, `${stem}.r${ref.revision}${extension}`);
    if (!existsSync(pinned)) {
      copyFileSync(source, pinned);
      chmodSync(pinned, 0o444);
    }
    // Hangul files also get their Markdown view, which is what the engine reads and edits; Office
    // files get a text view to read (edits go through the ieumoffice tool on the working copy).
    let pinnedView: string | null = null;
    if (office && this.ieum?.available) {
      pinnedView = join(pinnedDir, `${stem}.r${ref.revision}${extension}.md`);
      if (!existsSync(pinnedView)) {
        writeFileSync(pinnedView, await this.view(artifact.id, ref.revision));
        chmodSync(pinnedView, 0o444);
      }
    }
    if (hangul && this.kordoc?.available) {
      pinnedView = join(pinnedDir, `${stem}.r${ref.revision}${extension}.md`);
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
      const workingPath = join(draftDir, `${stem}.r${ref.revision}.${requestId.slice(0, 8)}${hangul ? `${extension}.md` : extension}`);
      if (hangul) writeFileSync(workingPath, await this.view(artifact.id, ref.revision));
      else copyFileSync(source, workingPath);
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
    return { artifactId: artifact.id, name: artifact.name, revision: ref.revision, mode: ref.mode, selection: ref.selection?.label ?? null };
  }

  /** The engine's turn is over: whatever is in the working copy becomes the proposal. */
  finishProposal(proposalId: string) {
    const proposal = this.proposal(proposalId);
    if (proposal.status !== "running") return proposal;
    const artifact = this.get(proposal.artifactId);
    const base = isHangul(artifact.format)
      ? readFileOrNull(join(this.root, artifact.id, `r${proposal.baseRevision}.view.md`))
      : readFileOrNull(this.revisionPath(proposal.artifactId, proposal.baseRevision));
    const working = readFileOrNull(proposal.workingPath);
    const now = Date.now();
    if (!base || !working || sha256(base) === sha256(working)) {
      const empty: Proposal = { ...proposal, status: "empty", updatedAt: now };
      this.saveProposal(empty);
      return empty;
    }
    const office = isOfficeFormat(artifact.format);
    const counts = office ? { added: 0, removed: 0 } : countChanges(base.toString("utf8"), working.toString("utf8"));
    const problem = artifact.format === "design" ? designProblem(working.toString("utf8")) : null;
    const pending: Proposal = { ...proposal, ...counts, problem, status: "pending", updatedAt: now };
    this.saveProposal(pending);
    if (office) void this.checkOffice(pending.id);
    return pending;
  }

  /** Why a document an engine just created cannot be opened, or null (Hangul through kordoc, Office through IeumOffice). */
  async newDocumentProblem(path: string): Promise<string | null> {
    const format = formatOf(path);
    if (format === "design") return designProblem(readFileOrNull(path)?.toString("utf8") ?? "");
    if (format && isOfficeFormat(format)) return this.officeProblem(path);
    if (format === "hwpx" && this.kordoc?.available) {
      try {
        await this.kordoc.read(path);
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

  private async officeProblem(path: string): Promise<string | null> {
    if (!this.ieum?.available) return null;
    try {
      await this.ieum.run(["info", path], [dirname(path)], 60_000);
      return null;
    } catch (error) {
      return `이음오피스가 이 파일을 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  runningProposals(sessionId: string) {
    return [...this.proposals.values()].filter((proposal) => proposal.sessionId === sessionId && proposal.status === "running");
  }

  /** Base, proposal and current text, for the preview. */
  async proposalTexts(proposalId: string) {
    const proposal = this.proposal(proposalId);
    const artifact = this.check(proposal.artifactId);
    return {
      proposal,
      artifact,
      base: await this.view(artifact.id, proposal.baseRevision),
      proposed: isOfficeFormat(artifact.format)
        ? existsSync(proposal.workingPath) && this.ieum?.available
          ? await this.ieum.textView(proposal.workingPath, artifact.format as "docx" | "pptx" | "xlsx")
          : ""
        : (readFileOrNull(proposal.workingPath)?.toString("utf8") ?? ""),
      current: await this.view(artifact.id, artifact.revision),
    };
  }

  /**
   * Apply only onto the revision the proposal was made from. A proposal made on r3 is never
   * written over r4: the user compares or asks again on the latest revision.
   */
  async applyProposal(proposalId: string) {
    const proposal = this.proposal(proposalId);
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
    const data = isHangul(artifact.format) ? await this.contentFor(artifact, proposal.baseRevision, working.toString("utf8")) : working;
    const latest = this.check(artifact.id);
    if (latest.revision !== proposal.baseRevision || latest.diskState !== "same") throw new HttpError(409, "stale_proposal", "적용하는 동안 문서가 바뀌었습니다.");
    writeAtomic(artifact.path, data);
    const updated = this.record(artifact, data, {
      author: "engine",
      sessionId: proposal.sessionId,
      baseRevision: proposal.baseRevision,
      note: "수정안 적용",
    });
    const applied: Proposal = { ...proposal, status: "applied", appliedRevision: updated.revision, updatedAt: Date.now() };
    this.saveProposal(applied);
    return { proposal: applied, artifact: updated };
  }

  discardProposal(proposalId: string) {
    const proposal = this.proposal(proposalId);
    if (proposal.status !== "pending" && proposal.status !== "running") return proposal;
    const discarded: Proposal = { ...proposal, status: "discarded", updatedAt: Date.now() };
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
    const lines = [`- 「${artifact.name}」 (${artifact.format}) 판 r${ref.revision} · sha256 ${this.revisionSha(artifact.id, ref.revision).slice(0, 12)}`];
    lines.push(`  · 이 판의 읽기 전용 사본: ${show(pinned)}`);
    if (pinnedView) lines.push(`  · 같은 판의 Markdown 보기(한글 문서 내용, 읽기 전용): ${show(pinnedView)}`);
    if (proposal && isHangul(artifact.format)) {
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
    const cli = this.ieum?.cli;
    const group = format === "docx" ? "docs" : format === "pptx" ? "slides" : "sheet";
    const guide = format === "docx" ? "docs" : format === "pptx" ? "slides" : "sheets";
    const lines = [`  · 이 문서는 ${format.toUpperCase()} 파일입니다. 압축을 풀거나 XML을 직접 고치지 말고 이음오피스 명령줄 도구를 쓰세요.`];
    if (textView) lines.push(`    글 보기(읽기 전용, 빠른 참고용): ${textView}`);
    if (!cli) {
      lines.push("    이 컴퓨터에는 이음오피스가 없어 읽기만 할 수 있습니다.");
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
  saveAsset(artifactId: string, data: Buffer, contentType: string, name: string) {
    const artifact = this.get(artifactId);
    if (artifact.format !== "design") throw new HttpError(400, "not_design", "디자인 문서가 아닙니다.");
    return { src: saveDesignAsset(artifact.path, data, contentType, name) };
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
