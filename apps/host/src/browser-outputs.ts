import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { BrowserOutput, BrowserOutputRequest, BrowserPage, Session } from "@workbench/contracts";
import type { Store } from "./store.ts";
import type { BrowserRegistry } from "./browser-registry.ts";
import type { Workspaces } from "./workspaces.ts";
import type { Documents } from "./artifacts.ts";
import { Attachments, MAX_ATTACHMENT } from "./attachments.ts";
import { physicalPath, withinDirectory } from "./directory-operations.ts";
import { HttpError } from "./errors.ts";

type Dependencies = {
  store: Pick<Store, "getMeta" | "setMeta" | "metaEntries">;
  browser: Pick<BrowserRegistry, "get" | "human">;
  workspaces: Pick<Workspaces, "requireActive">;
  documents: Pick<Documents, "track" | "list">;
  attachments: Attachments;
  hostId: string;
  session(id: string): Session | undefined;
};
type Stored = { signature: string; output: BrowserOutput };
const prefix = "shared-browser-output:";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const conflict = (message: string) => new HttpError(409, "browser_output", message);
const mimes: Record<string, string> = { ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".html": "text/html", ".json": "application/json" };
const mime = (name: string) => mimes[extname(name).toLowerCase()] ?? "application/octet-stream";
const safeName = (name: string) => basename(name).replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_").replace(/^\.+/, "").slice(0, 140) || "download.bin";

/** A copied web result uses the existing document revisions and content-addressed attachments. */
export class BrowserOutputs {
  private readonly pending = new Map<string, { signature: string; promise: Promise<BrowserOutput> }>();
  private readonly deps: Dependencies;
  constructor(deps: Dependencies) { this.deps = deps; }

  list(pageId: string): BrowserOutput[] {
    const page = this.deps.browser.get(pageId);
    this.deps.workspaces.requireActive(page.workspaceId, page.workId);
    return this.deps.store.metaEntries(prefix).map(entry => (JSON.parse(entry.value) as Stored).output)
      .filter(output => output.pageId === pageId && output.workspaceId === page.workspaceId && output.profileId === page.profileId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  save(pageId: string, input: BrowserOutputRequest): Promise<BrowserOutput> {
    if (!input || typeof input.requestId !== "string" || !/^[\w-]{1,120}$/.test(input.requestId)
      || !["download", "page-text"].includes(input.kind) || (input.kind === "download" && typeof input.downloadId !== "string")) {
      throw new HttpError(400, "browser_output_request", "보관할 웹 자료를 다시 선택해 주세요.");
    }
    const page = this.deps.browser.get(pageId);
    this.deps.workspaces.requireActive(page.workspaceId, page.workId);
    const signature = hash(JSON.stringify([pageId, page.profileId, page.workspaceId, input.kind, input.kind === "download" ? input.downloadId : null]));
    const raw = this.deps.store.getMeta(prefix + input.requestId);
    if (raw) {
      const saved = JSON.parse(raw) as Stored;
      if (saved.signature !== signature) throw conflict("다른 웹 자료에 사용한 요청입니다.");
      return Promise.resolve(saved.output);
    }
    const pending = this.pending.get(input.requestId);
    if (pending) {
      if (pending.signature !== signature) throw conflict("다른 웹 자료를 보관하고 있는 요청입니다.");
      return pending.promise;
    }
    const promise = this.copy(page, input).then(output => {
      this.deps.store.setMeta(prefix + input.requestId, JSON.stringify({ signature, output } satisfies Stored));
      return output;
    }).finally(() => this.pending.delete(input.requestId));
    this.pending.set(input.requestId, { signature, promise });
    return promise;
  }

  private async copy(page: BrowserPage, input: BrowserOutputRequest): Promise<BrowserOutput> {
    let bytes: Buffer, name: string, sourceUrl: string;
    if (input.kind === "download") {
      const download = page.native?.downloads?.find(entry => entry.id === input.downloadId);
      if (!download || download.status !== "completed" || !download.path || !download.sha256 || !/^[a-f0-9]{64}$/.test(download.sha256)) throw conflict("완료와 내용 확인을 마친 다운로드만 보관할 수 있습니다. 25MB가 넘는 파일은 다운로드 폴더에서 사용해 주세요.");
      // Only the native completion ledger supplies a path; a renderer cannot choose an arbitrary file.
      // The selected directory may change after completion, so the recorded accepted path is retained.
      const path = resolve(download.path);
      if (!isAbsolute(download.path) || !download.directory || physicalPath(dirname(path)) !== physicalPath(download.directory) || lstatSync(path).isSymbolicLink()) throw conflict("다운로드 파일이 다른 위치로 연결되어 보관하지 않았습니다.");
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size !== download.size || before.size > MAX_ATTACHMENT || !before.size) throw conflict("완료 파일의 크기가 바뀌었거나 첨부 한도를 넘었습니다.");
        const buffer = Buffer.alloc(before.size + 1); let length = 0;
        while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
        bytes = buffer.subarray(0, length);
        const after = fstatSync(fd);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size || hash(bytes) !== download.sha256) throw conflict("다운로드가 끝난 뒤 파일 내용이 바뀌어 보관하지 않았습니다.");
      } finally { closeSync(fd); }
      name = safeName(download.name); sourceUrl = download.url;
    } else {
      const result = await this.deps.browser.human(page.pageId, { requestId: `${input.requestId}-snapshot`, action: { kind: "snapshot" } });
      const observation = result.observation;
      if (result.error || !observation || observation.target.pageId !== page.pageId || observation.target.profileId !== page.profileId) throw conflict(result.error || "현재 웹 본문을 확인하지 못했습니다.");
      // Restart receipts intentionally redact snapshot text; never save that placeholder as page content.
      if (!observation.text.startsWith("URL: ")) throw conflict("이전 본문은 재시작 뒤 보관되지 않습니다. 현재 페이지에서 새 보관 요청을 선택해 주세요.");
      sourceUrl = observation.text.slice(5).split("\n", 1)[0]!;
      // Reuse the original visible-page snapshot, including its source URL and untrusted-content label.
      bytes = Buffer.from(`# 웹 페이지 기록\n\n보관 시각: ${new Date(observation.observedAt).toISOString()}\n\n${observation.text}\n`, "utf8");
      name = "웹 페이지 기록.md";
    }
    const current = this.deps.browser.get(page.pageId);
    if (current.profileId !== page.profileId || current.workspaceId !== page.workspaceId || current.workId !== page.workId) throw conflict("웹 탭의 작업공간이 바뀌었습니다.");
    const space = this.deps.workspaces.requireActive(page.workspaceId, page.workId), root = realpathSync(space.cwd);
    if (space.hostId !== this.deps.hostId) throw conflict("이 컴퓨터의 작업공간에서만 웹 자료를 보관할 수 있습니다.");
    const directory = join(root, "Browser", input.requestId);
    if (!withinDirectory(physicalPath(root), physicalPath(directory))) throw conflict("웹 자료 폴더가 작업공간 밖을 가리킵니다.");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!withinDirectory(physicalPath(root), physicalPath(directory))) throw conflict("웹 자료 폴더가 작업공간 밖으로 바뀌었습니다.");
    const path = join(realpathSync(directory), name);
    try { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || lstatSync(path).isSymbolicLink() || hash(readFileSync(path)) !== hash(bytes)) throw error;
      // Reconcile an interrupted response without overwriting an existing file.
    }
    const session = page.sessionId ? this.deps.session(page.sessionId) : undefined;
    const artifact = this.deps.documents.track(page.workId, space.cwd, path, "user", page.sessionId, `웹 자료 · ${sourceUrl}`)?.artifact
      ?? this.deps.documents.list().find(entry => entry.workId === page.workId && entry.path === path) ?? null;
    const attachment = this.deps.attachments.save(bytes, name, mime(name), MAX_ATTACHMENT, true), digest = hash(bytes);
    attachment.reference = { hostId: this.deps.hostId, workspaceId: page.workspaceId, artifactId: artifact?.id ?? `browser-${input.requestId}`, canonicalPath: path, revision: artifact ? String(artifact.revision) : digest, hash: digest, MIME: attachment.mime, sourceMessageId: `browser-output:${input.requestId}` };
    return { id: input.requestId, pageId: page.pageId, profileId: page.profileId, workId: page.workId, workspaceId: page.workspaceId,
      sourceUrl, sessionId: page.sessionId, parentSessionId: session?.pageAgent?.parentSessionId ?? null, createdAt: Date.now(),
      downloadId: input.kind === "download" ? input.downloadId : null, attachment, artifact };
  }
}
