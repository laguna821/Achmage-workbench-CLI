import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const service = new OfficeSkills(manager), root = join(work.cwd, ".claude/skills");
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
    const service = new OfficeSkills(f.manager), entry = f.manager.creations.get("office-template:restart")!;
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
