import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { EditorGrants } from "./editors.ts";
import { OfficeReferences } from "./office-references.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-references-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "첨부" }), session = manager.createSession(work.id, { provider: "claude" });
  const make = (name: string, text = "초기 자료") => {
    const file = join(work.cwd, name); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); return manager.openFile(work.id, file);
  };
  const own = make("현재.md"), source = make("참고/자료.md");
  const documents = manager.documents, grants = new EditorGrants();
  const opened = documents.registry.open(own.id, { viewId: "owner", windowId: "window", claim: true, sessionId: session.id });
  const access = { viewId: "owner", writeToken: opened.writeToken }, token = grants.issue(own.id, access, session.id);
  const context = { documents, grants, artifactId: own.id, token, access }, refs = grants.references;
  return { dir, manager, documents, grants, session, work, own, source, make, context, refs,
    select: () => refs.add(context, [source.path]),
    freeze: () => refs.freeze(context, [source.path], [null]),
    close: async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

it("lists known project documents, distinguishes same names, and refuses guessed/foreign/own paths", async () => {
  const f = fixture();
  try {
    const same = f.make("다른 폴더/자료.md"), other = f.manager.createWork({ title: "다른 프로젝트" });
    const foreign = join(other.cwd, "private.md"); writeFileSync(foreign, "not selected"); f.manager.openFile(other.id, foreign);
    const items = f.refs.list(f.context).items;
    expect(items.map((item) => item.path)).toEqual([f.source.path, same.path]); expect(items[0]!.dir).not.toBe(items[1]!.dir);
    expect(f.refs.add(f.context, [f.own.path, foreign, "/etc/passwd"])).toEqual({ accepted: [], rejected: [expect.any(String), expect.any(String), expect.any(String)] });
    expect(() => f.freeze()).toThrow(/선택한 파일/);
  } finally { await f.close(); }
});

it("uses the latest saved revision on each send and keeps that revision stable within the turn", async () => {
  const f = fixture();
  try {
    f.select();
    await f.documents.saveText(f.source.id, 1, "선택한 뒤 사람이 바꾼 최신 내용");
    const snap = f.freeze(); expect(snap.refs[0]).toMatchObject({ artifactId: f.source.id, revision: 2, mode: "review" });
    writeFileSync(f.source.path, "요청 도중 외부 변경");
    expect(await f.refs.read(f.context, snap.id, f.source.path)).toMatchObject({ ok: true, text: "선택한 뒤 사람이 바꾼 최신 내용" });
    const next = f.freeze(); expect(next.refs[0]!.revision).toBe(3);
    expect(await f.refs.read(f.context, next.id, f.source.path, 0, 5)).toMatchObject({ text: "요청 도중", totalChars: 11 });
    const binding = { artifactId: f.own.id, sessionId: f.session.id, owner: "run-owner", access: f.context.access };
    await f.manager.office.start(binding, { turnId: "attached", instruction: "자료를 읽어줘", revision: 1 }, snap.refs);
    expect(f.manager.items(f.session.id).items.find((item) => item.kind === "user")).toMatchObject({ refs: [expect.objectContaining({ mode: "edit" }), { artifactId: f.source.id, name: "자료.md", revision: 2, sha256: snap.refs[0]!.sha256, mode: "review", selection: null }] });
  } finally { await f.close(); }
});

it("refuses unsaved references, forged revisions and changed snapshot bytes before parsing", async () => {
  const f = fixture();
  try {
    f.select();
    f.documents.registry.open(f.source.id, { viewId: "source", windowId: "window", claim: true, dirty: true });
    expect(f.refs.list(f.context).items[0]!.state).toBe("modified"); expect(f.select().accepted).toHaveLength(0);
    expect(() => f.freeze()).toThrow(/저장하지 않은/);
    f.documents.registry.open(f.source.id, { viewId: "source", windowId: "window", dirty: false });
    expect(() => f.refs.freeze(f.context, [f.source.path], [19])).toThrow(/판이 바뀌/);
    const snap = f.freeze(), damaged = f.documents.revisionPath(f.source.id, 1);
    chmodSync(damaged, 0o600); writeFileSync(damaged, "corrupted");
    await expect(f.refs.read(f.context, snap.id, f.source.path)).rejects.toThrow(/해시/);
  } finally { await f.close(); }
});

it("rejects other views, selected-session changes and unselected paths even with a valid snapshot id", async () => {
  const f = fixture();
  try {
    f.select(); const snap = f.freeze();
    await expect(f.refs.read(f.context, snap.id, f.own.path)).rejects.toThrow(/첨부한 문서/);
    f.documents.registry.open(f.own.id, { viewId: "other", windowId: "window", sessionId: f.session.id });
    const token = f.grants.issue(f.own.id, { viewId: "other", writeToken: null }, f.session.id);
    await expect(f.refs.read({ ...f.context, token }, snap.id, f.source.path)).rejects.toThrow(/문서 창|편집 권한/);
    const session = f.manager.createSession(f.work.id, { provider: "claude" });
    f.documents.registry.open(f.own.id, { viewId: "owner", windowId: "window", sessionId: session.id });
    await expect(f.refs.read(f.context, snap.id, f.source.path)).rejects.toThrow(/세션이 바뀌/);
    const refreshed = f.grants.issue(f.own.id, f.context.access, session.id);
    await expect(f.refs.read({ ...f.context, token: refreshed }, snap.id, f.source.path)).rejects.toThrow(/참조 판/);
  } finally { await f.close(); }
});

it("uses the original Markdown withholding parser and never falls back to raw text on a malformed mark", async () => {
  const f = fixture();
  try {
    f.select(); await f.documents.saveText(f.source.id, 1, '공개 <span class="redact-span" data-redaction="" data-label="비공개">SECRET_PERSONAL_VALUE</span> 끝');
    const snap = f.freeze(), result = await f.refs.read(f.context, snap.id, f.source.path);
    expect(result).toMatchObject({ ok: true, text: "공개 {{비공개}} 끝" }); expect(JSON.stringify(result)).not.toContain("SECRET_PERSONAL_VALUE");
    await f.documents.saveText(f.source.id, 2, '공개 <span data-redaction="" data-label="비공개">SECRET_PERSONAL_VALUE');
    const failed = await f.refs.read(f.context, f.freeze().id, f.source.path);
    expect(failed.ok).toBe(false); expect(JSON.stringify(failed)).not.toContain("SECRET_PERSONAL_VALUE"); expect(failed).not.toHaveProperty("text");
  } finally { await f.close(); }
});

it("checks view ownership again after an asynchronous parser returns", async () => {
  const f = fixture();
  let finish!: (value: { ok: boolean; kind: "text"; text: string }) => void;
  const refs = new OfficeReferences(() => new Promise((resolve) => { finish = resolve; }));
  try {
    refs.add(f.context, [f.source.path]); const snap = refs.freeze(f.context, [f.source.path], [null]);
    const pending = refs.read(f.context, snap.id, f.source.path);
    f.documents.registry.close("owner", "window"); finish({ ok: true, kind: "text", text: "do not disclose" });
    await expect(pending).rejects.toThrow(/문서 창/);
  } finally { await f.close(); }
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8mcAAAAASUVORK5CYII=', 'base64');
it("imports only trusted native selections, tracks documents and freezes other supported files by content", async () => {
  const f = fixture();
  try {
    const csv = join(f.work.cwd, "수치.csv"), md = join(f.work.cwd, "새 자료.md"), image = join(f.work.cwd, "그림.png");
    writeFileSync(csv, "수치,값\nA,0007"); writeFileSync(md, "로컬 문서"); writeFileSync(image, png);
    expect(f.refs.add(f.context, [csv, image]).accepted).toHaveLength(0);
    const added = f.refs.importPaths(f.context, [csv, md, image]);
    expect(added.rejected).toEqual([]); expect(added.accepted).toHaveLength(3);
    const paths = added.accepted.map((a) => a.path), snap = f.refs.freeze(f.context, paths, [null, null, null]);
    expect(snap.refs).toHaveLength(1); expect(f.refs.readImage(f.context, null, image)).toMatchObject({ ok: true, base64: png.toString("base64"), mime: "image/png" });
    writeFileSync(csv, "다음 판"); writeFileSync(image, "damaged");
    expect(await f.refs.read(f.context, snap.id, csv)).toMatchObject({ ok: true, text: "수치,값\nA,0007" });
    expect(f.refs.readImage(f.context, snap.id, image).base64).toBe(png.toString("base64"));
    expect(() => f.refs.readImage(f.context, null, image)).toThrow(/이미지/);
    const next = f.refs.freeze(f.context, [csv], [null]);
    expect(await f.refs.read(f.context, next.id, csv)).toMatchObject({ text: "다음 판" });
    expect(f.refs.attachments(f.context, snap.id)[0]!.fileId).not.toBe(f.refs.attachments(f.context, next.id)[0]!.fileId);
  } finally { await f.close(); }
});

it("preserves uploaded names, original type checks, withholding and the original file/image caps", async () => {
  const f = fixture();
  try {
    const meta = f.refs.upload(f.context, Buffer.from('열린 값 <span data-redaction="" data-label="이름">UPLOAD_SECRET</span>'), "자료.md").accepted[0]!;
    expect(meta.name).toBe("자료.md");
    const snap = f.refs.freeze(f.context, [meta.path], [null]);
    expect(await f.refs.read(f.context, snap.id, meta.path)).toMatchObject({ ok: true, text: "열린 값 {{이름}}" });
    expect(() => f.refs.upload(f.context, Buffer.from("not png"), "가짜.png")).toThrow(/이미지/);
    expect(() => f.refs.upload(f.context, Buffer.alloc(5 * 1024 * 1024 + 1), "큰.png")).toThrow(/5MB/);
    expect(() => f.refs.upload(f.context, Buffer.alloc(50 * 1024 * 1024 + 1), "큰.txt")).toThrow(/50MB/);
    const text = f.refs.upload(f.context, Buffer.alloc(26 * 1024 * 1024, 65), "일반 첨부 상한보다 큰.txt");
    expect(text.accepted[0]!.sizeBytes).toBe(26 * 1024 * 1024);
    expect(() => f.refs.upload(f.context, Buffer.from("binary"), "실행파일.exe")).toThrow(/형식/);
    const fake = f.refs.upload(f.context, Buffer.from("%PDF-1.7\nwrong kind"), "가짜.docx").accepted[0]!;
    expect(fake.path.endsWith(".docx")).toBe(true);
    expect((await f.refs.read(f.context, f.refs.freeze(f.context, [fake.path], [null]).id, fake.path)).ok).toBe(false);
    const long = f.refs.upload(f.context, Buffer.from("%PDF-1.7\nlong name wrong kind"), "긴".repeat(130) + ".docx").accepted[0]!;
    expect(long.name.length).toBeLessThanOrEqual(120); expect(long.path.endsWith(".docx")).toBe(true);
    expect((await f.refs.read(f.context, f.refs.freeze(f.context, [long.path], [null]).id, long.path)).ok).toBe(false);
  } finally { await f.close(); }
});

it("restores authoritative attachment metadata into a fresh grant and keeps another conversation separate", async () => {
  const f = fixture();
  try {
    f.select(); const meta = f.refs.upload(f.context, png, "복원 그림.png").accepted[0]!;
    const paths = [f.source.path, meta.path], snap = f.refs.freeze(f.context, paths, [null, null]);
    const binding = { artifactId: f.own.id, sessionId: f.session.id, owner: "run-owner", access: f.context.access };
    await f.manager.office.start(binding, { turnId: "restore-files", instruction: "첨부 확인", revision: 1 }, snap.refs, f.refs.attachments(f.context, snap.id));
    f.manager.office.finish(binding, { turnId: "restore-files", status: "completed" });
    const saved = JSON.parse(JSON.stringify(f.manager.office.attachmentHistory(binding)));
    const grants = new EditorGrants(), token = grants.issue(f.own.id, f.context.access, f.session.id), context = { ...f.context, grants, token };
    expect(() => grants.references.freeze(context, paths, [null, null])).toThrow(/선택한 파일/);
    expect(grants.references.restore(context, saved).map((a) => a.name)).toEqual(["자료.md", "복원 그림.png"]);
    const restored = grants.references.freeze(context, paths, [null, null]);
    expect(grants.references.readImage(context, restored.id, meta.path).base64).toBe(png.toString("base64"));
    const next = f.manager.createSession(f.work.id, { provider: "claude" });
    f.documents.registry.open(f.own.id, { viewId: "owner", windowId: "window", sessionId: next.id });
    const nextContext = { ...context, token: grants.issue(f.own.id, f.context.access, next.id) };
    expect(() => grants.references.freeze(nextContext, paths, [null, null])).toThrow(/선택한 파일/);
    expect(grants.references.restore(nextContext, [])).toEqual([]);
  } finally { await f.close(); }
});
