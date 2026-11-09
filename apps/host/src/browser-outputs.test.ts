import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserDownload, BrowserPage, Session, Work } from "@workbench/contracts";
import { Attachments } from "./attachments.ts";
import { Documents } from "./artifacts.ts";
import { BrowserOutputs } from "./browser-outputs.ts";
import { EventBus } from "./bus.ts";
import { Store } from "./store.ts";
import { Workspaces } from "./workspaces.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wb-web-output-")), cwd = join(root, "workspace"), downloads = join(root, "downloads");
  mkdirSync(cwd); mkdirSync(downloads);
  const store = new Store(join(root, "state.sqlite")), bus = new EventBus();
  const work = { id: "work", title: "자료", cwd, cwdManaged: false, createdAt: Date.now(), updatedAt: Date.now(), activeSessionId: null, folderId: null } as Work;
  store.saveWork(work);
  const workspaces = new Workspaces(store, "here", bus), space = workspaces.defaultFor(work);
  const documents = new Documents(store, bus, root, null, null, workspaces), attachments = new Attachments(root);
  const child = { id: "child", workId: work.id, workspaceId: space.id, pageAgent: { pageId: "page", parentSessionId: "parent" } } as Session;
  const page: BrowserPage = { pageId: "page", profileId: "profile", workId: work.id, workspaceId: space.id, driverId: "driver", url: "https://example.test/private", title: "자료", status: "ready", sessionId: child.id, control: { generation: 0, owner: "human" }, createdAt: 1, updatedAt: 1, error: null,
    native: { pageId: "page", profileId: "profile", navigationRevision: 1, capabilities: ["observe", "downloads"], url: "https://example.test/private", title: "자료", loading: false, control: { generation: 0, owner: "human" }, popups: [], error: null, downloads: [], downloadDirectory: downloads } };
  const browser = { get: (id: string) => { if (id !== page.pageId) throw Error("missing page"); return page; }, human: vi.fn(async (_id: string, input: { requestId: string }) => ({ id: input.requestId, pageId: page.pageId, page: page.native!, observation: { target: page.native!, documentNonce: "document", observedAt: 100, text: `URL: ${page.url}\nUNTRUSTED WEB CONTENT\n원래 페이지의 본문` } })) };
  const outputs = new BrowserOutputs({ store, browser, workspaces, documents, attachments, hostId: "here", session: id => id === child.id ? child : undefined });
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const download = (text = "# 원본 다운로드\n") => {
    const path = join(downloads, randomUUID() + ".md"); writeFileSync(path, text);
    const record: BrowserDownload = { id: randomUUID(), url: "https://example.test/export", name: "자료.md", path, directory: downloads, requestedAt: 10, finishedAt: 20, status: "completed", size: Buffer.byteLength(text), sha256: sha(text), error: null };
    page.native!.downloads!.push(record); return record;
  };
  return { root, cwd, downloads, page, browser, store, outputs, documents, attachments, download, space };
}

it("copies a verified native download into the exact workspace and reconciles the same immutable result", async () => {
  const f = fixture(), download = f.download(), request = { requestId: randomUUID(), kind: "download" as const, downloadId: download.id };
  const output = await f.outputs.save(f.page.pageId, request);
  expect(output).toMatchObject({ pageId: "page", profileId: "profile", workspaceId: f.space.id, sourceUrl: download.url, sessionId: "child", parentSessionId: "parent", downloadId: download.id });
  expect(output.artifact).toMatchObject({ workspaceId: f.space.id, workId: "work", revision: 1, sha256: download.sha256 });
  expect(output.attachment.reference).toMatchObject({ hostId: "here", workspaceId: f.space.id, artifactId: output.artifact!.id, hash: download.sha256, sourceMessageId: `browser-output:${request.requestId}` });
  expect(readFileSync(output.artifact!.path, "utf8")).toBe("# 원본 다운로드\n");
  writeFileSync(download.path!, "# 나중에 바뀐 원본\n");
  expect(await f.outputs.save(f.page.pageId, request)).toEqual(output);
  expect(readFileSync(f.attachments.path(output.attachment.id), "utf8")).toBe("# 원본 다운로드\n");
  expect(f.outputs.list("page")).toEqual([output]);
  expect(() => f.outputs.save("page", { requestId: request.requestId, kind: "page-text" })).toThrow("다른 웹 자료");
});

it("rejects incomplete, modified, foreign-folder and symlink download files without making documents", async () => {
  const f = fixture(), pending = f.download(); pending.status = "downloading";
  await expect(f.outputs.save("page", { requestId: randomUUID(), kind: "download", downloadId: pending.id })).rejects.toThrow("완료");
  const changed = f.download("same-size"), changedBytes = "different"; writeFileSync(changed.path!, changedBytes);
  await expect(f.outputs.save("page", { requestId: randomUUID(), kind: "download", downloadId: changed.id })).rejects.toThrow("내용이 바뀌어");
  const elsewhere = f.download(); elsewhere.directory = f.cwd;
  await expect(f.outputs.save("page", { requestId: randomUUID(), kind: "download", downloadId: elsewhere.id })).rejects.toThrow("다른 위치");
  const linked = f.download(), actual = linked.path!; linked.path = join(f.downloads, "linked.md"); symlinkSync(actual, linked.path);
  await expect(f.outputs.save("page", { requestId: randomUUID(), kind: "download", downloadId: linked.id })).rejects.toThrow("다른 위치");
  expect(f.documents.list()).toHaveLength(0); expect(existsSync(join(f.cwd, "Browser"))).toBe(false);
});

it("uses the visible page snapshot and records a document without navigating or executing the download", async () => {
  const f = fixture(), requestId = randomUUID();
  const output = await f.outputs.save("page", { requestId, kind: "page-text" });
  expect(f.browser.human).toHaveBeenCalledExactlyOnceWith("page", { requestId: `${requestId}-snapshot`, action: { kind: "snapshot" } });
  expect(output.sourceUrl).toBe(f.page.url);
  expect(readFileSync(output.artifact!.path, "utf8")).toContain("UNTRUSTED WEB CONTENT\n원래 페이지의 본문");
  expect(output.attachment.id).toBe(`${output.artifact!.sha256}.md`);
});

it("does not write through a Browser directory linked outside the selected workspace", async () => {
  const f = fixture(), download = f.download(), outside = join(f.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(f.cwd, "Browser"), "dir");
  await expect(f.outputs.save("page", { requestId: randomUUID(), kind: "download", downloadId: download.id })).rejects.toThrow("작업공간 밖");
  expect(f.outputs.list("page")).toEqual([]); expect(f.documents.list()).toHaveLength(0);
});
