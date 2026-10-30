import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import type { OfficeSkillView } from "../../packages/contracts/src/office-skills.ts";
import type { Engines } from "./launch.ts";
import { fixture } from "./office-suite.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

const COMPOSER = ".ai-panel textarea:not(:disabled), .copilot textarea:not(:disabled)";
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Actual original pickers, skill tool, capability, journal and internal editor.
 * Only the remote model is a private local SSE fixture; no paid provider runs. */
export async function officeSkillsScenario(ctx: Ctx, launch: { binary: string; engines: Engines; profile?: string }) {
  let wd = ctx.app.wd, requests: any[] = [], selectedId = "";
  const api = <T,>(method: string, path: string, body?: unknown) => ctx.app.api<T>(method, path, body);
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  const formats = ["pptx", "docx", "xlsx", "html", "hwpx", "xmind", "epub", "md", "pdf"] as const;
  const chosen = process.env.APP_E2E_OFFICE_SKILL_FORMATS?.split(",") ?? [...formats];
  if (chosen.some((format) => !(formats as readonly string[]).includes(format))) throw new Error("Unknown skill format");
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
      const body = JSON.parse(raw); requests.push(body); res.setHeader("content-type", "text/event-stream");
      const send = (delta: unknown, finish_reason: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const lastUser = JSON.stringify(body.messages.findLast((m: any) => m.role === "user"));
      if (body.messages.at(-1)?.role !== "tool" && !lastUser.includes("NO_SKILLS")) {
        if (!body.tools?.some((t: any) => t.function?.name === "read_skill_file")) throw new Error("Original read_skill_file missing");
        send({ role: "assistant", tool_calls: [{ index: 0, id: `skill-${requests.length}`, type: "function", function: { name: "read_skill_file", arguments: JSON.stringify({ id: selectedId, path: "guide.md" }) } }] }, "tool_calls");
      } else send({ role: "assistant", content: "SKILL_READ_COMPLETE" }, "stop");
      res.end("data: [DONE]\n\n");
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const enter = async (id: string, format: string) => {
    await wd.frame(null); await wd.frame(await wd.waitFor(`iframe.office-frame[src*=${JSON.stringify(`a=${id}`)}]`, 30000)); await installProbe(wd);
    if (format === "xlsx" && !await until(() => wd.execute<boolean>('return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중");'), 45000)) throw new Error("Workbook not ready");
    if (!await until(async () => { const input = await wd.find(COMPOSER); return !!input && await wd.displayed(input); }, 45000)) throw new Error("Original composer not ready");
  };
  const pick = async (name: string, trigger = "/") => {
    const input = await wd.waitFor(COMPOSER); await wd.click(input); await wd.sendKeys(input, `${trigger}${name}`);
    const row = await wd.waitFor(".ai-skill-picker-row:not(.ai-skill-picker-manage)", 15000);
    if (!(await wd.execute<string>("return arguments[0].textContent;", row)).includes(name)) throw new Error("Wrong skill picker result");
    await wd.click(row);
    if (!await until(() => wd.execute<boolean>('return [...document.querySelectorAll(".ai-skill-chips .ai-skill-chip-title")].some(e=>e.textContent.includes(arguments[0]));', name))) throw new Error("Skill chip was not selected");
  };
  const send = async (text: string) => { const input = await wd.waitFor(COMPOSER); await wd.click(input); await wd.sendKeys(input, text); await wd.click(await wd.waitFor(".ai-send-btn:not(.ai-stop-btn):not(:disabled)")); };
  try {
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "skills-fixture";
    settings.customEndpoints = [{ id: "skills-fixture", name: "Local skill fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "skills-model", kind: "local", modelProfiles: { "skills-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    for (const format of chosen as (typeof formats)[number][]) {
      const S = `Office 스킬 ${format}`; requests = [];
      try {
        const work = await api<Work>("POST", "/api/works", { title: `스킬과 양식 ${format}`, cwd: null });
        const file = join(work.cwd, `원본.${format}`);
        if (format === "docx") copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), file); else await fixture(file, format);
        const own = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
        const root = join(work.cwd, ".claude/skills");
        const make = (name: string, body: string, template?: string) => {
          const dir = join(root, name); mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Native original Office fixture\nmetadata:\n  ieum-title: ${name}\n${template ? `  ieum-template: assets/${template}\n` : ""}---\n${body}\n`);
          return dir;
        };
        const reading = make("native-reading", "NATIVE_SKILL_BODY_V1\nRead guide.md when asked."), style = make("native-style", "NATIVE_STYLE_BODY");
        writeFileSync(join(reading, "guide.md"), "NATIVE_SKILL_GUIDE_V1");
        const targetFormat = format === "pptx" ? "docx" : format;
        const template = make("native-template", "NATIVE_TEMPLATE_BODY", `template.${targetFormat}`);
        mkdirSync(join(template, "assets")); const templateFile = join(template, "assets", `template.${targetFormat}`);
        if (targetFormat === "docx") copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), templateFile); else await fixture(templateFile, targetFormat);
        const templateHash = hash(templateFile), sourceHash = hash(file);
        const tab = { id: "skill-source", workId: work.id, sessionId: null as string | null, view: { kind: "document", artifactId: own.id, proposalId: null }, ui: { mode: format === "html" || format === "md" ? "rich" : "edit" } };
        const layout = () => ({ version: 2, focus: "skill-pane", panes: [{ ...tab, id: "skill-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] });
        await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout() }); await wd.setWindowRect({ width: 1900, height: 1200 }); await wd.refresh(); await enter(own.id, format);
        const listed = await wd.execute<OfficeSkillView[]>("return window.aiOfficeUserSkills.list();"); selectedId = listed.find((s) => s.name === "native-reading")!.id;
        await pick("native-reading"); await pick("native-style", "$");
        ctx.report.check(S, "원본 /·$ 선택 메뉴와 두 스킬 칩", await wd.execute<boolean>('return document.querySelectorAll(".ai-skill-chips .ai-skill-chip").length===2;'), undefined, await shot(ctx, `skills-${format}-picker.png`));
        await send("선택한 스킬과 guide.md를 읽어 줘");
        let session: Session | undefined;
        if (!await until(async () => { session = (await snapshot()).sessions.find((s) => s.workId === work.id); return !!session; }, 20000)) throw new Error("First skill session missing");
        if (!await until(async () => (await items(session!.id)).some((i) => i.kind === "turnEnd"), 60000)) throw new Error("Skill turn did not finish");
        const first = await items(session!.id), user = first.find((i) => i.kind === "user");
        const ok = first.some((i) => i.kind === "turnEnd" && i.status === "completed");
        ctx.report.check(S, "원본 스킬 본문·두 칩·정확한 해시를 같은 대화에 기록", ok && user?.office?.skills?.length === 2 && user.office.skillReads?.some((r) => r.sha256 === hash(join(reading, "SKILL.md"))) === true && user?.kind === "user" && user.text === "선택한 스킬과 guide.md를 읽어 줘" && JSON.stringify(requests[0]).includes("NATIVE_SKILL_BODY_V1") && JSON.stringify(requests[0]).includes("NATIVE_STYLE_BODY"));
        ctx.report.check(S, "원본 read_skill_file 도구로 실제 자료 읽기", first.some((i) => i.kind === "tool" && i.output?.includes("NATIVE_SKILL_GUIDE_V1")), undefined, await shot(ctx, `skills-${format}-read.png`));
        writeFileSync(ctx.report.path(`skills-${format}-first.json`), JSON.stringify({ first, requests }, null, 2));
        if (!ok) throw new Error("First skill request failed");
        requests = []; await send("같은 대화에서 스킬 내용을 계속 참고해 줘");
        if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length === 2, 60000)) throw new Error("Live skill follow-up did not finish");
        ctx.report.check(S, "같은 대화의 후속 AI 요청에 앞서 읽은 스킬 문맥 유지", JSON.stringify(requests[0]).includes("NATIVE_SKILL_BODY_V1") && JSON.stringify(requests[0]).includes("NATIVE_STYLE_BODY"));
        writeFileSync(ctx.report.path(`skills-${format}-live-followup.json`), JSON.stringify({ items: await items(session!.id), requests }, null, 2));
        const firstErrors = await pageErrors(wd); requests = [];
        writeFileSync(join(reading, "SKILL.md"), readFileSync(join(reading, "SKILL.md"), "utf8").replace("BODY_V1", "BODY_V2"));
        writeFileSync(join(reading, "guide.md"), "NATIVE_SKILL_GUIDE_V2"); tab.sessionId = session!.id;
        await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout() });
        if (format === chosen[0]) { await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "skills-restarted" }); wd = ctx.app.wd; } else await wd.refresh();
        await enter(own.id, format);
        const restored = await until(() => wd.execute<boolean>('return [...document.querySelectorAll(".ai-msg-skill-chips .ai-skill-chip")].some(e=>e.textContent.includes("native-reading"));'));
        ctx.report.check(S, format === chosen[0] ? "실제 앱 재시작 뒤 대화의 스킬 칩 복원" : "문서 재열기 뒤 대화의 스킬 칩 복원", restored);
        if (!restored) throw new Error("Stored skill chips missing");
        await send("같은 스킬의 최신 자료를 읽어 줘");
        if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length === 3, 60000)) throw new Error("Restored skill request did not finish");
        const second = await items(session!.id), again = second.filter((i) => i.kind === "user").at(-1);
        ctx.report.check(S, "재선택 없이 최신 본문·자료·해시로 후속 요청", JSON.stringify(requests[0]).includes("NATIVE_SKILL_BODY_V2") && second.filter((i) => i.kind === "tool").at(-1)?.output?.includes("NATIVE_SKILL_GUIDE_V2") === true && again?.office?.skillReads?.some((r) => r.sha256 === hash(join(reading, "SKILL.md"))) === true);
        writeFileSync(ctx.report.path(`skills-${format}-restored.json`), JSON.stringify({ second, requests }, null, 2));
        requests = []; await pick("native-reading"); await pick("native-template", "$"); await send("이 양식 사본으로 문서를 만들어 줘");
        let copy: Artifact | undefined;
        if (!await until(async () => { copy = (await snapshot()).artifacts.find((a) => a.workId === work.id && a.name.startsWith("native-template")); return !!copy; }, 30000)) throw new Error(`Template copy missing: ${await wd.execute('return document.body.innerText.slice(-5000);')}`);
        await enter(copy!.id, targetFormat);
        if (!await until(async () => (await items(session!.id)).some((i) => i.kind === "turnEnd" && i.office?.artifactId === copy!.id), 60000)) throw new Error(`Template handoff missing: ${await wd.execute('return document.body.innerText.slice(-5000);')}`);
        const copiedItems = await items(session!.id), copiedUser = copiedItems.find((i) => i.kind === "user" && i.office?.artifactId === copy!.id);
        ctx.report.check(S, "양식 원본 보존·현재 작업공간에 정확한 사본 생성", hash(templateFile) === templateHash && hash(file) === sourceHash && hash(copy!.path) === templateHash && copy!.workspaceId === session!.workspaceId);
        ctx.report.check(S, "내부 새 편집기·같은 대화에 모든 스킬을 한 번만 인계", copiedUser?.office?.skills?.length === 2 && copiedItems.filter((i) => i.kind === "user" && i.office?.artifactId === copy!.id).length === 1 && (await snapshot()).sessions.filter((s) => s.workId === work.id).length === 1, undefined, await shot(ctx, `skills-${format}-template.png`));
        writeFileSync(ctx.report.path(`skills-${format}-template.json`), JSON.stringify({ copy, copiedItems, requests }, null, 2));
        if (format === chosen[0] && targetFormat === "docx") {
          const editor = await wd.waitFor('.tiptap[contenteditable="true"]', 30000); await wd.click(await wd.waitFor(".tiptap p")); await wd.sendKeys(editor, " TEMPLATE_MANUAL_EDIT");
          requests = []; const count = copiedItems.filter((i) => i.kind === "turnEnd").length;
          await send("사람이 고친 문서를 확인해 줘");
          if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length > count, 60000)) throw new Error("Edited template follow-up missing");
          const latest = (await snapshot()).artifacts.find((a) => a.id === copy!.id)!;
          ctx.report.check(S, "사본 직접 편집·저장 후 같은 세션의 AI 입력에 최신 문서 반영", latest.revision > 1 && hash(latest.path) !== templateHash && hash(templateFile) === templateHash && JSON.stringify(requests).includes("TEMPLATE_MANUAL_EDIT"), undefined, await shot(ctx, "skills-template-followup.png"));
        }
        ctx.report.check(S, "스킬·복원·양식 인계 중 페이지 예외 없음", firstErrors.length === 0 && (await pageErrors(wd)).length === 0, JSON.stringify([...firstErrors, ...await pageErrors(wd)]));
        void style;
      } catch (error) {
        ctx.report.check(S, "스킬·양식 진행", false, String(error), await shot(ctx, `skills-${format}-failed.png`).catch(() => null));
        writeFileSync(ctx.report.path(`skills-${format}-diagnostic.json`), JSON.stringify({ error: String(error), page: await wd.execute('return document.body.innerText.slice(-12000);').catch(() => null), errors: await pageErrors(wd).catch(() => []), requests }, null, 2)); break;
      } finally { await wd.frame(null); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}
