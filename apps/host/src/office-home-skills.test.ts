import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { OfficeSkills } from "./office-skills.ts";
import { OfficeKnowledge } from "./office-knowledge.mjs";
import { EditorGrants } from "./editors.ts";
import type { OfficeSkillView } from "../../../packages/contracts/src/office-skills.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-home-skills-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", dataDir: dir, managedWorksDir: join(dir, "works"), skillHomeDir: join(dir, "home") });
  const work = manager.createWork({ title: "Home templates" }), knowledge = new OfficeKnowledge(dir, manager), skills = new OfficeSkills(manager, store);
  const owner = knowledge.home.open(), context = { owner, destination: { workId: work.id }, assertAlive: () => { knowledge.home.require(owner); } };
  const source = join(work.cwd, ".claude/skills/report"); mkdirSync(join(source, "assets"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: report\ndescription: Reports\nmetadata:\n  ieum-title: 보고서\n  ieum-template: assets/report.docx\n---\nKeep the original theme.\n");
  writeFileSync(join(source, "assets/report.docx"), "ORIGINAL_TEMPLATE_BYTES");
  writeFileSync(join(source, "guide.md"), "READABLE_GUIDE"); writeFileSync(join(source, "run.sh"), "NEVER_EXECUTE");
  const call = (operation: string, input?: unknown) => skills.home.invoke(context, operation, input);
  const chosen = async () => (await call("list") as OfficeSkillView[]).find(skill => skill.name === "report")!;
  const documentContext = (artifactId: string, sessionId: string, viewId: string) => {
    const view = manager.documents.registry.open(artifactId, { windowId: viewId, viewId, sessionId, claim: true }), grants = new EditorGrants();
    return { artifactId, grants, token: grants.issue(artifactId, { viewId, writeToken: view.writeToken }, sessionId) };
  };
  return { dir, store, manager, work, knowledge, skills, source, owner, context, call, chosen, documentContext, close: async () => { knowledge.close(); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
it("uses project/global skill precedence without a hidden home session and rechecks closed owners", async () => {
  const f = fixture();
  try {
    const chosen = await f.chosen(); expect(chosen.templateExists).toBe(true);
    expect(await f.call("ai-read-file", { id: chosen.id, path: "guide.md" })).toEqual({ ok: true, text: "READABLE_GUIDE" });
    expect(await f.call("ai-read-file", { id: chosen.id, path: "run.sh" })).toEqual({ ok: false, reason: "not-text" });
    expect(await f.skills.home.invoke({ ...f.context, destination: undefined }, "list")).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: chosen.id })]));
    expect(f.manager.snapshot().sessions).toHaveLength(0);
    f.knowledge.home.close(f.owner);
    await expect(f.call("ai-read", { id: chosen.id })).rejects.toMatchObject({ status: 410 });
  } finally { await f.close(); }
});
it("saves a home proposal once after name/revision checks without publishing to a CLI chat", async () => {
  const f = fixture();
  try {
    const input = { card: { id: "proposal", label: "my-report" }, name: "my-report", title: "나의 보고서", description: "Reports", body: "PRESERVED_INSTRUCTIONS", invoke: "manual" };
    await expect(f.call("save-card", input)).rejects.toMatchObject({ code: "office_skill_unchecked" });
    expect(await f.call("check-name", { name: input.name, card: input.card })).toEqual({ ok: true });
    const saved = await f.call("save-card", input); expect(saved).toMatchObject({ ok: true });
    expect(await f.call("save-card", input)).toEqual(saved);
    expect(readFileSync(join(f.manager.userSkills.appDir, "my-report/SKILL.md"), "utf8")).toContain("PRESERVED_INSTRUCTIONS");
    expect(f.manager.snapshot().sessions).toHaveLength(0);
    const other = f.knowledge.home.open();
    await expect(f.skills.home.invoke({ ...f.context, owner: other, assertAlive: () => { f.knowledge.home.require(other); } }, "save-card", input)).rejects.toMatchObject({ code: "office_skill_unchecked" });
    await expect(f.call("save-card", { ...input, body: "CHANGED" })).rejects.toMatchObject({ code: "request_id_conflict" });
    const restarted = new OfficeSkills(f.manager, f.store);
    expect(await restarted.home.invoke(f.context, "save-card", input)).toEqual(saved);
  } finally { await f.close(); }
});
it("copies a home template without clobbering and hands it only to its real document child once", async () => {
  const f = fixture();
  try {
    const main = f.manager.createSession(f.work.id, { provider: "claude" }), chosen = await f.chosen();
    writeFileSync(join(f.work.cwd, "보고서.docx"), "EXISTING_FILE");
    const input = { requestId: "once", skillId: chosen.id, text: "자료를 바탕으로 작성해 줘", chips: [{ id: chosen.id, source: "forged", title: "forged" }] };
    const opened = await f.call("open-template", input) as { ok: boolean; tabId: string };
    expect(await f.call("open-template", input)).toEqual(opened);
    const artifact = f.manager.documents.get(opened.tabId), snapshot = f.manager.snapshot();
    const child = snapshot.sessions.find(session => session.documentAgent?.artifactId === artifact.id)!;
    expect(snapshot.sessions).toHaveLength(2); expect(child.documentAgent?.parentSessionId).toBe(main.id);
    expect(snapshot.works.find(work => work.id === f.work.id)?.activeSessionId).toBe(main.id);
    expect(readFileSync(artifact.path, "utf8")).toBe("ORIGINAL_TEMPLATE_BYTES");
    expect(readFileSync(join(f.work.cwd, "보고서.docx"), "utf8")).toBe("EXISTING_FILE");
    expect(readFileSync(join(f.source, "assets/report.docx"), "utf8")).toBe("ORIGINAL_TEMPLATE_BYTES");
    expect(f.store.items(main.id)).toHaveLength(0);
    const doc = f.documentContext(artifact.id, child.id, "child");
    const handoff = await f.skills.read(doc, "take-handoff", { target: "docs" });
    expect(handoff).toMatchObject({ text: input.text, chips: [{ id: chosen.id, source: "project", title: "보고서" }] });
    expect(await f.skills.read(doc, "take-handoff", { target: "docs" })).toBeNull();
    const other = f.knowledge.home.open();
    await expect(f.skills.home.invoke({ ...f.context, owner: other, assertAlive: () => { f.knowledge.home.require(other); } }, "focus-tab", { tabId: artifact.id })).rejects.toMatchObject({ code: "knowledge_template_scope" });
    await expect(f.call("open-template", { ...input, text: "changed" })).rejects.toMatchObject({ code: "request_id_conflict" });
    const next = await f.call("open-template", { ...input, requestId: "pending" }) as { tabId: string };
    const nextChild = f.manager.snapshot().sessions.find(session => session.documentAgent?.artifactId === next.tabId)!;
    const restarted = new OfficeSkills(f.manager, f.store);
    expect(await restarted.read(f.documentContext(next.tabId, nextChild.id, "recovered"), "take-handoff", { target: "docs" })).toBeNull();
    expect(f.store.items(nextChild.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "notice", text: expect.stringContaining("자동 재전송하지") })]));
  } finally { await f.close(); }
});
it("refuses a template if its home closes during the asynchronous snapshot", async () => {
  const f = fixture();
  try {
    const chosen = await f.chosen(), original = f.manager.userSkills.templateSnapshot.bind(f.manager.userSkills);
    vi.spyOn(f.manager.userSkills, "templateSnapshot").mockImplementation(async (...args) => { const copy = await original(...args); f.knowledge.home.close(f.owner); return copy; });
    await expect(f.call("open-template", { requestId: "closed", skillId: chosen.id, text: "작성", chips: [chosen] })).rejects.toMatchObject({ status: 410 });
    expect(readdirSync(f.work.cwd).filter(path => path.endsWith(".docx"))).toEqual([]);
    expect(f.manager.snapshot().sessions).toHaveLength(0);
  } finally { await f.close(); }
});
