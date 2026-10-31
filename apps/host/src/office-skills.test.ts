import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { OfficeSkills, officeSkillId } from "./office-skills.ts";
import { EditorGrants, createEditorsServer } from "./editors.ts";
import { OfficeAi } from "./office-ai.ts";
import type { OfficeSkillRead, OfficeSkillView } from "../../../packages/contracts/src/office-skills.ts";

function skill(root: string, name: string, body = "SKILL_BODY_V1", template?: string) {
  const dir = join(root, name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Office fixture\nmetadata:\n  ieum-title: ${name} 양식\n${template ? `  ieum-template: assets/${template}\n` : ""}---\n${body}\n`);
  if (template) { mkdirSync(join(dir, "assets"), { recursive: true }); writeFileSync(join(dir, "assets", template), "ORIGINAL_TEMPLATE_BYTES"); }
  return dir;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-skills-")), home = join(dir, "home"), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir, skillHomeDir: home });
  const work = manager.createWork({ title: "Office skills" }), session = manager.createSession(work.id, { provider: "claude" });
  const path = join(work.cwd, "source.md"); writeFileSync(path, "SOURCE_UNCHANGED");
  const artifact = manager.openFile(work.id, path), grant = new EditorGrants();
  const view = manager.documents.registry.open(artifact.id, { viewId: "source", windowId: "window", sessionId: session.id, claim: true });
  const token = grant.issue(artifact.id, { viewId: "source", writeToken: view.writeToken }, session.id);
  const context = { artifactId: artifact.id, token, grants: grant };
  const service = new OfficeSkills(manager, store), root = join(work.cwd, ".claude/skills");
  const list = () => service.read(context, "list") as Promise<OfficeSkillView[]>;
  const read = (id: string) => service.read(context, "ai-read", { id }) as Promise<{ ok: true; skill: OfficeSkillRead }>;
  return { dir, home, store, manager, work, session, artifact, grant, context, service, root, list, read,
    close: async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it("uses the existing source precedence without exposing directories or turning imports on", async () => {
  const f = fixture();
  try {
    skill(f.root, "same"); skill(join(f.home, ".codex/skills"), "same", "CODEX_BODY"); skill(f.manager.userSkills.appDir, "imported");
    const list = await f.list(), project = list.find((s) => s.source === "project")!;
    expect(project).toMatchObject({ enabled: true, invoke: "manual", name: "same" });
    expect(list.find((s) => s.source === "codex")).toMatchObject({ shadowedBy: project.id });
    expect(list.find((s) => s.name === "imported")).toMatchObject({ enabled: false, invoke: "manual" });
    expect(JSON.stringify(list)).not.toContain(f.dir);
    expect(await f.read(project.id)).toMatchObject({ ok: true, skill: { body: "SKILL_BODY_V1\n", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(await f.service.read(f.context, "ai-read", { id: list.find((s) => s.source === "codex")!.id })).toEqual({ ok: false, reason: "disabled" });
  } finally { await f.close(); }
});
it("reads bounded UTF-8 assets inside enabled skills and refuses scripts, traversal and escaped links", async () => {
  const f = fixture();
  try {
    const dir = skill(f.root, "assets"), outside = join(f.dir, "secret.txt"); writeFileSync(outside, "DO_NOT_READ");
    writeFileSync(join(dir, "guide.md"), "GUIDE"); writeFileSync(join(dir, "run.sh"), "exit 99");
    writeFileSync(join(dir, "invalid.txt"), Buffer.from([0xff])); writeFileSync(join(dir, "large.txt"), "a".repeat(1_000_001));
    symlinkSync(outside, join(dir, "escape.txt")); const id = (await f.list())[0]!.id;
    expect(await f.service.read(f.context, "ai-read-file", { id, path: "./guide.md" })).toEqual({ ok: true, text: "GUIDE" });
    for (const path of ["../secret.txt", "/secret.txt", "C:\\secret.txt"]) expect(await f.service.read(f.context, "ai-read-file", { id, path })).toEqual({ ok: false, reason: "outside" });
    expect(await f.service.read(f.context, "ai-read-file", { id, path: "run.sh" })).toEqual({ ok: false, reason: "not-text" });
    expect(await f.service.read(f.context, "ai-read-file", { id, path: "escape.txt" })).toEqual({ ok: false, reason: "not-found" });
    expect(await f.service.read(f.context, "ai-read-file", { id, path: "invalid.txt" })).toEqual({ ok: false, reason: "not-text" });
    await expect(f.service.read(f.context, "ai-read-file", { id, path: "large.txt" })).rejects.toThrow(/너무 크/);
    expect((await f.read(id)).skill.files).not.toContain("run.sh");
    expect(readFileSync(outside, "utf8")).toBe("DO_NOT_READ");
  } finally { await f.close(); }
});
it("revalidates version and state, then persists only visible text plus canonical skill chips and hashes", async () => {
  const f = fixture();
  try {
    const dir = skill(f.root, "chosen"), view = (await f.list())[0]!, read = (await f.read(view.id)).skill;
    const context = { text: "VISIBLE_REQUEST", chips: [{ id: view.id, source: "forged", title: "forged" }], reads: [{ id: view.id, sha256: read.sha256 }] };
    const prepared = await f.service.prepare(f.context, context);
    expect(prepared?.skills[0]).toMatchObject({ title: "chosen 양식", source: "project", sha256: read.sha256 });
    const binding = { artifactId: f.artifact.id, sessionId: f.session.id, owner: "owner", access: f.grant.access(f.context.token) };
    await f.manager.office.start(binding, { turnId: "skills", instruction: "VISIBLE_REQUEST\nPRIVATE_SKILL_BODY", revision: 1 }, [], [], prepared);
    expect(f.store.items(f.session.id)[0]).toMatchObject({ text: "VISIBLE_REQUEST", office: { skills: prepared?.skills, skillReads: prepared?.skillReads } });
    f.manager.office.finish(binding, { turnId: "skills", status: "completed" });
    writeFileSync(join(dir, "SKILL.md"), readFileSync(join(dir, "SKILL.md"), "utf8").replace("SKILL_BODY_V1", "SKILL_BODY_V2"));
    await expect(f.service.prepare(f.context, context)).rejects.toThrow(/바뀌었/);
    const latest = (await f.read(view.id)).skill; expect(latest.body).toContain("V2");
    const native = (await f.manager.userSkills.list(f.manager.skillScope(f.session.id))).find((s) => officeSkillId(s) === view.id)!;
    await f.manager.userSkills.setState(native.id, { enabled: false, invoke: "manual" }, f.manager.skillScope(f.session.id));
    await expect(f.service.prepare(f.context, { ...context, reads: [{ id: view.id, sha256: latest.sha256 }] })).rejects.toThrow(/꺼졌/);
    await expect(f.service.prepare(f.context, { ...context, reads: [] })).rejects.toThrow(/읽기 기록/);
  } finally { await f.close(); }
});
it("rejects a retired view and a late list result after its session changes", async () => {
  const f = fixture();
  try {
    skill(f.root, "one"); const actual = f.manager.userSkills.list.bind(f.manager.userSkills);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(f.manager.userSkills, "list").mockImplementationOnce(async (scope) => { const list = await actual(scope); await gate; return list; });
    const pending = f.list();
    const next = f.manager.createSession(f.work.id, { provider: "codex" });
    f.manager.documents.registry.open(f.artifact.id, { viewId: "source", windowId: "window", sessionId: next.id });
    release(); await expect(pending).rejects.toThrow(/セ|세션/);
    await expect(f.read("project:unknown")).rejects.toThrow(/세션/);
  } finally { await f.close(); }
});
it.each(["docx", "pptx", "xlsx", "hwp", "hwpx", "pdf", "xmind", "epub", "html", "md"])("reserves a %s template copy once and hands all chips to its writer once", async (extension) => {
  const f = fixture();
  try {
    const template = skill(f.root, "template", "TEMPLATE", `source.${extension}`); skill(f.root, "style", "STYLE");
    const list = await f.list(), chosen = list.find((s) => s.name === "template")!, chips = list.map(({ id, source, title }) => ({ id, source, title }));
    const input = { requestId: "once", skillId: chosen.id, text: "새 양식 문서를 작성해 줘", chips };
    const created = await f.service.action(f.context, "open-template", input) as { ok: true; tabId: string };
    expect(await f.service.action(f.context, "open-template", input)).toEqual(created);
    const artifact = f.manager.documents.get(created.tabId), entry = f.manager.creations.get("office-template:once")!;
    expect(readFileSync(artifact.path, "utf8")).toBe("ORIGINAL_TEMPLATE_BYTES");
    expect(readFileSync(join(template, "assets", `source.${extension}`), "utf8")).toBe("ORIGINAL_TEMPLATE_BYTES");
    expect(readFileSync(f.artifact.path, "utf8")).toBe("SOURCE_UNCHANGED");
    expect(f.manager.creations.list()).toHaveLength(1); expect(entry.office?.handoff.chips).toHaveLength(2);
    expect(artifact.workspaceId).toBe(f.session.workspaceId);
    const opened = f.manager.documents.registry.open(created.tabId, { viewId: "copy", windowId: "window", sessionId: f.session.id, claim: true });
    const token = f.grant.issue(created.tabId, { viewId: "copy", writeToken: opened.writeToken }, f.session.id), context = { ...f.context, artifactId: created.tabId, token };
    expect(await f.service.read(context, "take-handoff", { target: "wrong" })).toBeNull();
    expect(await f.service.read(context, "take-handoff", { target: entry.office!.handoff.target })).toEqual(entry.office!.handoff);
    expect(await f.service.read(context, "take-handoff", { target: entry.office!.handoff.target })).toBeNull();
    expect(f.manager.items(f.session.id).items.some((i) => i.kind === "user")).toBe(false);
  } finally { await f.close(); }
});
it("keeps a queued copy after restart without automatically replaying the handed request", async () => {
  const f = fixture();
  try {
    skill(f.root, "template", "TEMPLATE", "copy.docx"); const chosen = (await f.list())[0]!;
    const created = await f.service.action(f.context, "open-template", { requestId: "restart", skillId: chosen.id, text: "DO_NOT_AUTO_RUN", chips: [chosen] }) as { tabId: string };
    const service = new OfficeSkills(f.manager, f.store), entry = f.manager.creations.get("office-template:restart")!;
    expect(entry.office?.state).toBe("interrupted"); expect(readFileSync(f.manager.documents.get(created.tabId).path, "utf8")).toBe("ORIGINAL_TEMPLATE_BYTES");
    expect(f.manager.items(f.session.id).items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "notice", text: expect.stringContaining("DO_NOT_AUTO_RUN") })]));
    expect(await service.action(f.context, "focus-tab", { tabId: created.tabId })).toEqual({ ok: true, tabId: created.tabId });
    expect(await service.action(f.context, "focus-tab", { tabId: f.artifact.id })).toEqual({ ok: false, reason: "not-found" });
  } finally { await f.close(); }
});
it("serves reads through a document grant while keeping writes off the editor origin", async () => {
  const f = fixture(); const ai = new OfficeAi(f.dir, undefined, f.manager.office, undefined, f.service);
  const server = createEditorsServer(f.manager.documents, f.grant, null, ai);
  try {
    skill(f.root, "one"); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/artifacts/${f.artifact.id}/ai/skills`;
    expect((await fetch(`${base}/list`)).status).toBe(401);
    const headers = { authorization: `Bearer ${f.context.token}` };
    const response = await fetch(`${base}/list`, { headers }); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toHaveLength(1);
    expect((await fetch(`${base}/list`, { headers, method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/open-template`, { headers, method: "POST", body: "{}" })).status).toBe(404);
  } finally { await new Promise<void>((done) => server.close(() => done())); await f.close(); }
});

const proposed = (id: string, name = "saved-card", targetId?: string) => ({
  card: { id, label: name, ...(targetId ? { targetId } : {}) }, name, title: "사용자 스킬",
  description: "Only when preparing a report", body: "CARD_BODY", invoke: "auto" as const,
  ...(targetId ? { targetId } : {}),
});
async function checkCard(f: ReturnType<typeof fixture>, input: Pick<ReturnType<typeof proposed>, "name" | "card">) {
  return f.service.read(f.context, "check-name", { name: input.name, card: input.card });
}
it("writes nothing before the original card's explicit Save, then keeps one saved row across restart and duplicate delivery", async () => {
  const f = fixture();
  try {
    const input = proposed("new-card");
    expect(await checkCard(f, input)).toEqual({ ok: true });
    expect(existsSync(f.manager.userSkills.appDir)).toBe(false);
    expect(f.store.items(f.session.id)).toHaveLength(0);
    const result = await f.service.action(f.context, "save-card", input);
    expect(result).toMatchObject({ ok: true });
    expect(await f.list()).toEqual([expect.objectContaining({ name: input.name, enabled: true, invoke: "auto", owned: true })]);
    expect(f.store.items(f.session.id)).toEqual([expect.objectContaining({ title: input.name, output: expect.stringContaining("skill-card-saved:"), office: expect.objectContaining({ cardSaved: { skillId: (result as { id: string }).id, label: input.name } }) })]);
    expect(f.manager.office.nativeContext(f.session.id).text).toBe("");
    const restarted = new OfficeSkills(f.manager, f.store);
    expect(await restarted.action(f.context, "save-card", input)).toEqual(result);
    expect(f.store.items(f.session.id)).toHaveLength(1);
    await expect(restarted.action(f.context, "save-card", { ...input, body: "DIFFERENT" })).rejects.toThrow(/다른 요청/);
    expect(readFileSync(join(f.manager.userSkills.appDir, input.name, "SKILL.md"), "utf8")).toContain("CARD_BODY");
  } finally { await f.close(); }
});
it("copies an installed folder only on Save and keeps explicit selection scoped to this project even when the copy is disabled or removed", async () => {
  const f = fixture();
  try {
    const source = skill(join(f.home, ".claude/skills"), "installed", "ORIGINAL", "model.md");
    writeFileSync(join(source, "guide.md"), "KEPT_ASSET");
    const original = readFileSync(join(source, "SKILL.md")), id = (await f.list())[0]!.id;
    const input = proposed("copy-card", "installed", id); await checkCard(f, input);
    const result = await f.service.action(f.context, "save-card", input) as { id: string };
    const all = await f.manager.userSkills.list({ projectRoot: f.work.cwd, provider: "claude" }), copy = all.find((s) => officeSkillId(s) === result.id)!;
    expect(copy).toMatchObject({ shadowedBy: null, state: { enabled: true, invoke: "auto" } });
    expect((await f.list()).find((s) => s.id === id)?.shadowedBy).toBe(result.id);
    expect((await f.manager.userSkills.list({ projectRoot: join(f.dir, "other-project"), provider: "claude" })).find((s) => s.source === "claude")?.shadowedBy).toBeNull();
    expect(readFileSync(join(copy.dir, "guide.md"), "utf8")).toBe("KEPT_ASSET");
    expect(readFileSync(join(copy.dir, "assets/model.md"), "utf8")).toBe("ORIGINAL_TEMPLATE_BYTES");
    await f.manager.userSkills.setState(copy.id, { enabled: false, invoke: "manual" }, { projectRoot: f.work.cwd, provider: "claude" });
    expect(await f.read(id)).toEqual({ ok: false, reason: "disabled" });
    rmSync(copy.dir, { recursive: true });
    expect(await f.read(id)).toEqual({ ok: false, reason: "disabled" });
    expect(await f.manager.userSkills.setState(all.find((s) => s.source === "claude")!.id, { enabled: true, invoke: "manual" }, { projectRoot: f.work.cwd, provider: "claude" })).toMatchObject({ shadowedBy: null, state: { enabled: true } });
    expect((await f.read(id)).ok).toBe(true);
    expect(readFileSync(join(source, "SKILL.md"))).toEqual(original);
  } finally { await f.close(); }
});
it("keeps a renamed installed copy selected, preserves own assets, and retains replaced folders", async () => {
  const f = fixture();
  try {
    skill(join(f.home, ".claude/skills"), "source-card", "ORIGINAL", "model.md");
    const nativeId = (await f.list())[0]!.id, first = proposed("copy-renamed", "my-copy", nativeId); await checkCard(f, first);
    const own = await f.service.action(f.context, "save-card", first) as { id: string };
    expect((await f.list()).find((s) => s.id === nativeId)?.shadowedBy).toBe(own.id);
    const rename = { ...proposed("edit-renamed", "my-renamed-copy", own.id), body: "OWN_RENAMED", invoke: "manual" as const };
    await checkCard(f, rename);
    const result = await f.service.action(f.context, "save-card", rename) as { id: string };
    expect((await f.list()).find((s) => s.id === nativeId)?.shadowedBy).toBe(result.id);
    expect(existsSync(join(f.manager.userSkills.appDir, "my-copy"))).toBe(false);
    expect(readFileSync(join(f.manager.userSkills.appDir, "my-renamed-copy/assets/model.md"), "utf8")).toBe("ORIGINAL_TEMPLATE_BYTES");
    const backups = join(f.dir, "skill-backups"), folder = readdirSync(backups)[0]!;
    expect(readFileSync(join(backups, folder, "my-copy/SKILL.md"), "utf8")).toContain("CARD_BODY");
    expect((await f.list()).find((s) => s.id === result.id)?.invoke).toBe("manual");
  } finally { await f.close(); }
});
for (const changed of ["SKILL.md", "guide.md"]) it(`rejects a card whose source ${changed} changed after review, without rewriting either folder`, async () => {
  const f = fixture();
  try {
    const dir = skill(join(f.home, ".claude/skills"), "stale-card"); writeFileSync(join(dir, "guide.md"), "OLD");
    const input = proposed("stale", "stale-card", (await f.list())[0]!.id); await checkCard(f, input);
    const before = readFileSync(join(dir, changed), "utf8"); writeFileSync(join(dir, changed), before + "\nUSER_CHANGED");
    await expect(f.service.action(f.context, "save-card", input)).rejects.toThrow(/바뀌/);
    expect(readFileSync(join(dir, changed), "utf8")).toContain("USER_CHANGED");
    expect(existsSync(join(f.manager.userSkills.appDir, "stale-card"))).toBe(false);
    expect(f.store.items(f.session.id)).toHaveLength(0);
  } finally { await f.close(); }
});
it("requires the checked own collision and explicit overwrite before copying over it", async () => {
  const f = fixture();
  try {
    const ownDir = skill(f.manager.userSkills.appDir, "mine", "OLD_MINE"); skill(join(f.home, ".claude/skills"), "installed-other", "NATIVE");
    const input = proposed("replace", "mine", (await f.list()).find((s) => s.name === "installed-other")!.id);
    expect(await checkCard(f, input)).toEqual({ ok: false, problem: "taken" });
    await expect(f.service.action(f.context, "save-card", input)).rejects.toThrow(/이미 있는/);
    expect(readFileSync(join(ownDir, "SKILL.md"), "utf8")).toContain("OLD_MINE");
    expect(await f.service.action(f.context, "save-card", { ...input, overwrite: true })).toMatchObject({ ok: true });
    expect(readFileSync(join(ownDir, "SKILL.md"), "utf8")).toContain("CARD_BODY");
    const backups = join(f.dir, "skill-backups"), folder = readdirSync(backups)[0]!;
    expect(readFileSync(join(backups, folder, "mine/SKILL.md"), "utf8")).toContain("OLD_MINE");
  } finally { await f.close(); }
});
it("does not save an unchecked card, a different target, a traversal template, or a stale document grant", async () => {
  const f = fixture();
  try {
    const input = proposed("boundary");
    await expect(f.service.action(f.context, "save-card", input)).rejects.toThrow(/다시 확인/);
    await checkCard(f, input);
    await expect(f.service.action(f.context, "save-card", { ...input, targetId: "unexpected" })).rejects.toThrow(/대상/);
    await expect(f.service.action(f.context, "save-card", { ...input, template: { fileName: "../escape.md", base64: Buffer.from("ESCAPE").toString("base64") } })).rejects.toThrow(/이름과 크기/);
    f.manager.documents.registry.close("source", "window");
    await expect(f.service.action(f.context, "save-card", input)).rejects.toThrow(/바뀌/);
    expect(existsSync(join(f.manager.userSkills.appDir, input.name))).toBe(false);
  } finally { await f.close(); }
});
it("rechecks the document/session after asynchronous staging, before committing a card", async () => {
  const f = fixture();
  try {
    const input = proposed("during-save"); await checkCard(f, input);
    const original = f.manager.userSkills.mutate.bind(f.manager.userSkills);
    vi.spyOn(f.manager.userSkills, "mutate").mockImplementationOnce((run) => original(async () => { f.manager.documents.registry.close("source", "window"); return run(); }));
    await expect(f.service.action(f.context, "save-card", input)).rejects.toThrow(/바뀌/);
    expect(existsSync(join(f.manager.userSkills.appDir, input.name))).toBe(false);
  } finally { await f.close(); }
});
it("leaves an interrupted save for inspection rather than repeating it after a host restart", async () => {
  const f = fixture();
  try {
    const input = proposed("interrupted"); await checkCard(f, input); await f.service.action(f.context, "save-card", input);
    const stored = f.store.metaEntries("office-skill-card:")[0]!, value = JSON.parse(stored.value);
    f.store.setMeta(stored.key, JSON.stringify({ ...value, status: "saving", item: undefined, result: undefined }));
    const restarted = new OfficeSkills(f.manager, f.store);
    await expect(restarted.action(f.context, "save-card", input)).rejects.toThrow(/보관함/);
    expect(JSON.parse(f.store.getMeta(stored.key)!).status).toBe("interrupted");
    expect(f.store.items(f.session.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "notice", text: expect.stringContaining("자동 반복하지") })]));
    expect(readdirSync(f.manager.userSkills.appDir).filter((name) => !name.startsWith("."))).toEqual([input.name]);
  } finally { await f.close(); }
});
it("keeps a project-owned skill authoritative and refuses copying it from an Office card", async () => {
  const f = fixture();
  try {
    skill(f.root, "project-card");
    await expect(checkCard(f, proposed("project", "project-card", (await f.list())[0]!.id))).rejects.toThrow(/다시 확인/);
    expect(existsSync(f.manager.userSkills.appDir)).toBe(false);
  } finally { await f.close(); }
});

function previewInput(id = "preview", targetId?: string, redacted = false) {
  const input = proposed(`card-${id}`, `skill-${id}`, targetId);
  return { requestId: id, card: input.card, fileName: "source.md", title: "원본", tabTitle: "빈 양식", text: "일회성 내용을 지워 빈 양식을 만들어 줘", originalRedacted: redacted,
    base64: Buffer.from("UNSAVED_CURRENT_BYTES").toString("base64"),
    proposal: { key: `proposal-${id}`, name: input.name, title: input.title, description: input.description, body: input.body, wantsTemplate: true,
      ...(targetId ? { target: { id: targetId, name: "installed", title: "Installed", source: "user", owned: false } } : {}) }, draft: input };
}
async function openPreview(f: ReturnType<typeof fixture>, input = previewInput()) {
  await checkCard(f, input.draft);
  const answer = await f.service.action(f.context, "open-preview", input) as { ok: true; tabId: string; previewId: string };
  const view = f.manager.documents.registry.open(answer.tabId, { viewId: `preview-${input.requestId}`, windowId: "preview-window", sessionId: f.session.id, claim: true });
  const token = f.grant.issue(answer.tabId, { viewId: view.view.viewId, writeToken: view.writeToken }, f.session.id);
  return { ...answer, context: { artifactId: answer.tabId, token, grants: f.grant }, path: f.manager.documents.get(answer.tabId).path, view };
}
it("opens current edited bytes in a separate document, preserves the original snapshot, and only hands the clearing request over once", async () => {
  const f = fixture();
  try {
    const input = previewInput(), p = await openPreview(f, input);
    expect(readFileSync(f.artifact.path, "utf8")).toBe("SOURCE_UNCHANGED");
    expect(readFileSync(p.path, "utf8")).toBe("UNSAVED_CURRENT_BYTES");
    expect(f.manager.creations.get(p.previewId)?.skillPath).toBeNull();
    expect(await f.service.action(f.context, "open-preview", input)).toMatchObject({ tabId: p.tabId, previewId: p.previewId });
    expect(await f.service.read(p.context, "take-handoff", { target: "markdown" })).toMatchObject({ resumed: false, text: input.text, chips: [], preview: { originalRedacted: false, proposal: { key: input.proposal.key } } });
    expect(await f.service.read(p.context, "take-handoff", { target: "markdown" })).toMatchObject({ resumed: true });
    writeFileSync(p.path, "CLEARED_THEN_PERSON_EDITED");
    const restarted = new OfficeSkills(f.manager, f.store);
    expect(await restarted.read(p.context, "take-handoff", { target: "markdown" })).toMatchObject({ resumed: true });
    expect(await restarted.read(p.context, "preview-original", { previewId: p.previewId })).toMatchObject({ base64: input.base64, fileName: "source.md" });
    expect(readFileSync(p.path, "utf8")).toBe("CLEARED_THEN_PERSON_EDITED");
    expect(existsSync(f.manager.userSkills.appDir)).toBe(false);
    await expect(restarted.action(f.context, "open-preview", { ...input, text: "CHANGED" })).rejects.toThrow(/재사용/);
  } finally { await f.close(); }
});
it("restores a queued preview as a card after restart without automatically repeating an uncertain model request", async () => {
  const f = fixture();
  try {
    const p = await openPreview(f), restarted = new OfficeSkills(f.manager, f.store);
    expect(await restarted.read(p.context, "take-handoff", { target: "markdown" })).toMatchObject({ resumed: true });
    expect(f.store.items(f.session.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "notice", text: expect.stringContaining("자동 재전송하지") })]));
  } finally { await f.close(); }
});
for (const close of [false, true]) it(`${close ? "tab close" : "Cancel"} ends the preview without a skill write and retains the document copy`, async () => {
  const f = fixture();
  try {
    const p = await openPreview(f);
    if (close) f.service.previews.close(p.tabId, { viewId: p.view.view.viewId, writeToken: p.view.writeToken });
    else await f.service.action(p.context, "finish-preview", { previewId: p.previewId, outcome: "unsaved" });
    expect(await f.service.read(f.context, "preview-events", {})).toEqual([expect.objectContaining({ previewId: p.previewId, outcome: "unsaved" })]);
    expect(await f.service.read(p.context, "take-handoff", { target: "markdown" })).toBeNull();
    expect(existsSync(p.path)).toBe(true);
    expect(existsSync(f.manager.userSkills.appDir)).toBe(false);
    expect(f.store.items(f.session.id).some((item) => item.office?.cardSaved)).toBe(false);
    await expect(f.service.read(p.context, "preview-original", { previewId: p.previewId })).rejects.toThrow(/끝난/);
  } finally { await f.close(); }
});
it("denies a redacted original at the host and commits only the explicitly chosen edited template, recovering its completion after restart", async () => {
  const f = fixture();
  try {
    const input = previewInput("redacted", undefined, true), p = await openPreview(f, input);
    await expect(f.service.read(p.context, "preview-original", { previewId: p.previewId })).rejects.toThrow(/가림/);
    const save = { ...input.draft, card: { ...input.card, id: "preview-card", previewId: p.previewId }, template: { fileName: "source.md", base64: Buffer.from("BLANK_AND_PERSON_EDITED").toString("base64") } };
    await f.service.read(p.context, "check-name", { name: save.name, card: save.card });
    const saved = await f.service.action(p.context, "save-card", save) as { id: string };
    expect(await f.service.action(p.context, "save-card", save)).toEqual(saved);
    await expect(f.service.action(p.context, "save-card", { ...save, body: "DIFFERENT" })).rejects.toThrow(/다른 요청/);
    expect(readFileSync(join(f.manager.userSkills.appDir, save.name, "assets/source.md"), "utf8")).toBe("BLANK_AND_PERSON_EDITED");
    expect(await f.service.action(p.context, "finish-preview", { previewId: p.previewId, outcome: "saved", saved: { skillId: saved.id, title: save.title } })).toEqual({ ok: true });
    await f.service.action(p.context, "finish-preview", { previewId: p.previewId, outcome: "unsaved" });
    expect(await f.service.read(f.context, "preview-events", {})).toEqual([expect.objectContaining({ outcome: "saved", skillId: saved.id })]);
    const entry = f.manager.creations.get(p.previewId)!;
    f.manager.creations.update(entry.requestId, { office: { ...entry.office!, preview: { ...entry.office!.preview!, status: "open", skillId: undefined } } });
    const restarted = new OfficeSkills(f.manager, f.store);
    expect(await restarted.read(f.context, "preview-events", {})).toEqual([expect.objectContaining({ outcome: "saved", skillId: saved.id })]);
    expect(f.store.items(f.session.id).filter((item) => item.office?.cardSaved)).toHaveLength(1);
    expect(readFileSync(f.artifact.path, "utf8")).toBe("SOURCE_UNCHANGED");
  } finally { await f.close(); }
});
it("carries the reviewed skill revision into a preview so changes during clearing cannot be silently overwritten", async () => {
  const f = fixture();
  try {
    const dir = skill(join(f.home, ".claude/skills"), "installed");
    const input = previewInput("revision", (await f.list())[0]!.id), p = await openPreview(f, input);
    writeFileSync(join(dir, "SKILL.md"), readFileSync(join(dir, "SKILL.md"), "utf8") + "\nEXTERNAL_EDIT");
    const save = { ...input.draft, card: { ...input.card, id: "preview-revision-card", previewId: p.previewId } };
    await f.service.read(p.context, "check-name", { name: save.name, card: save.card });
    await expect(f.service.action(p.context, "save-card", save)).rejects.toThrow(/바뀌었/);
    expect(existsSync(join(f.manager.userSkills.appDir, save.name))).toBe(false);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("EXTERNAL_EDIT");
  } finally { await f.close(); }
});
it("rejects a different document/session, invented save completion, and a close without the writer lease", async () => {
  const f = fixture();
  try {
    const p = await openPreview(f);
    await expect(f.service.read(f.context, "preview-original", { previewId: p.previewId })).rejects.toThrow();
    await expect(f.service.action(p.context, "finish-preview", { previewId: p.previewId, outcome: "saved", saved: { skillId: "invented", title: "Forged" } })).rejects.toThrow(/확인하지/);
    expect(() => f.service.previews.close(p.tabId, { viewId: "source", writeToken: null })).toThrow();
    const other = f.manager.createSession(f.work.id, { provider: "claude" });
    f.manager.documents.registry.open(p.tabId, { viewId: "other", windowId: "other", sessionId: other.id, claim: true });
    const token = f.grant.issue(p.tabId, { viewId: "other", writeToken: null }, other.id);
    await expect(f.service.read({ artifactId: p.tabId, token, grants: f.grant }, "take-handoff", { target: "markdown" })).rejects.toThrow();
    expect(existsSync(f.manager.userSkills.appDir)).toBe(false);
  } finally { await f.close(); }
});
it("does not let tab cancellation race a card commit", async () => {
  const f = fixture();
  try {
    const input = previewInput("race"), p = await openPreview(f, input);
    const save = { ...input.draft, card: { ...input.card, id: "preview-race", previewId: p.previewId } };
    await f.service.read(p.context, "check-name", { name: save.name, card: save.card });
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; }), entered = new Promise<void>((resolve) => { started = resolve; });
    const mutate = f.manager.userSkills.mutate.bind(f.manager.userSkills);
    vi.spyOn(f.manager.userSkills, "mutate").mockImplementationOnce((run) => mutate(async () => { started(); await blocked; return run(); }));
    const pending = f.service.action(p.context, "save-card", save); await entered;
    try {
      await expect(f.service.action(p.context, "finish-preview", { previewId: p.previewId, outcome: "unsaved" })).rejects.toThrow(/저장 중/);
      expect(() => f.service.previews.close(p.tabId, { viewId: p.view.view.viewId, writeToken: p.view.writeToken })).toThrow(/저장 중/);
    } finally { release(); }
    await pending;
    expect(await f.service.read(f.context, "preview-events", {})).toEqual([expect.objectContaining({ outcome: "saved" })]);
  } finally { await f.close(); }
});
