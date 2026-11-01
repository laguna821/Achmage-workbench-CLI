import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import type { OfficeSkillView } from "../../packages/contracts/src/office-skills.ts";
import { kbCiteHref } from "../../vendor/ieumoffice/packages/agent-core/src/knowledge-base-skill.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

/** Original home/AgentLoop/tools and bundled DOCX conversion; only the provider is a fixture. */
export async function knowledgeHomeScenario(ctx: Ctx) {
  const S = "지식베이스 홈", { wd, api } = ctx.app, requests: { phase: string; body: any }[] = [];
  let phase = "answer", step = 0, skillId = "";
  const folder = join(ctx.stage.outDir, "home-references"); mkdirSync(folder, { recursive: true });
  const source = join(folder, "연구자료.md"), other = join(folder, "다른그룹.md");
  const original = '---\r\n"DIKM_단계:": ""\r\ntags: [Workflow_Engineering]\r\nunknown: null\r\n---\r\n# 연구자료\r\nHOMEINFO HOME_PUBLIC_VALUE\r\n<span class="redact-span" data-redaction="" data-label="가린 값">HOME_SECRET_VALUE</span>\r\n';
  writeFileSync(source, original); writeFileSync(other, "# 다른 그룹\nHOMEINFO OTHER_GROUP_PRIVATE\n");
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
      const body = JSON.parse(raw); requests.push({ phase, body }); step++;
      const answer = [
        { name: "search_knowledge_base", input: { query: "HOMEINFO", limit: 8 } },
        { name: "read_knowledge_file", input: { index: 0, offset: 0 } },
        { name: "create_document", input: { title: "생성답변", format: "md", content: "# 생성답변\nHOME_CREATED_MD\n" } },
      ];
      const skills = [
        { name: "read_skill_file", input: { id: skillId, path: "guide.md" } },
        { name: "propose_skill", input: { name: "native-home-card", description: "Use for research reports", body: "HOME_CARD_INSTRUCTIONS", wantsTemplate: false } },
      ];
      const call = (phase === "answer" ? answer : phase === "skills" ? skills : [])[step - 1];
      if (call && !body.tools?.some((tool: any) => tool.function?.name === call.name)) throw new Error("Missing original tool: " + call.name);
      const text = phase === "answer" ? `HOME_ANSWER_DONE 자료를 정리했습니다. [연구자료.md](${kbCiteHref(source)})` : phase === "skills" ? "HOME_SKILLS_DONE" : "HOME_TEMPLATE_DONE";
      const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `home-${phase}-${step}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { role: "assistant", content: text };
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No home fixture port");
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  const clickText = async (text: string, selector = "button") => {
    const button = await wd.execute<any>('return [...document.querySelectorAll(arguments[1])].find(e=>e.textContent.trim()===arguments[0]);', text, selector);
    if (!button) throw new Error("Missing button: " + text);
    await wd.execute('arguments[0].scrollIntoView({block:"center"});', button); await wd.click(button);
  };
  const enter = async () => { await wd.frame(null); await wd.frame(await wd.waitFor('iframe[title="지식베이스 질문 화면"]', 30000)); await wd.waitFor(".kb-ask", 30000); await installProbe(wd); };
  const open = async () => { await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]')); await clickText("지식베이스…"); await enter(); };
  const send = async (text: string) => { const input = await wd.waitFor('.kb-ask textarea:not(:disabled)', 30000); await wd.click(input); await wd.sendKeys(input, text); await wd.click(await wd.waitFor('.ai-send-btn:not(.ai-stop-btn):not(:disabled)', 30000)); };
  const finished = async (marker: string) => { if (!await until(() => wd.execute<boolean>('return document.querySelector(".kb-ask-thread")?.textContent.includes(arguments[0]) && !document.querySelector(".ai-stop-btn");', marker), 60000)) throw new Error("Home answer did not finish: " + marker); };
  const pick = async (name: string) => {
    const input = await wd.waitFor('.kb-ask textarea:not(:disabled)'); await wd.click(input); await wd.sendKeys(input, "/" + name);
    await wd.click(await wd.waitFor(".ai-skill-picker-row:not(.ai-skill-picker-manage)", 15000));
    if (!await until(() => wd.execute<boolean>('return document.querySelector(".ai-skill-chips")?.textContent.includes(arguments[0]);', name))) throw new Error("Home chip missing");
  };
  try {
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "home-fixture";
    settings.customEndpoints = [{ id: "home-fixture", name: "Local home fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "home-model", kind: "local", modelProfiles: { "home-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    const work = await api<Work>("POST", "/api/works", { title: "지식베이스 홈 인수", cwd: null });
    const main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
    writeFileSync(join(work.cwd, "생성답변.md"), "EXISTING_ANSWER");
    const skillRoot = join(work.cwd, ".claude/skills");
    for (const name of ["native-home-reading", "native-home-template"]) {
      const dir = join(skillRoot, name); mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Research home fixture\nmetadata:\n  ieum-title: ${name}\n${name.endsWith("template") ? "  ieum-template: assets/template.docx\n" : ""}---\nHOME_SKILL_INSTRUCTIONS\nRead guide.md when requested.\n`);
      writeFileSync(join(dir, "guide.md"), "HOME_SKILL_GUIDE");
      if (name.endsWith("template")) copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), join(dir, "assets/template.docx"));
    }
    const template = join(skillRoot, "native-home-template/assets/template.docx"), digest = () => createHash("sha256").update(readFileSync(template)).digest("hex"), beforeTemplate = digest();
    const tab = { id: "home-project", workId: work.id, sessionId: main.id, view: { kind: "project", workId: work.id }, ui: {} };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "home-pane", panes: [{ ...tab, id: "home-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1700, height: 1100 }); await wd.refresh(); await open();
    ctx.report.check(S, "원본 빈 자료 안내와 질문 화면", !!await wd.find(".kb-ask-hero"), undefined, await shot(ctx, "home-empty.png"));
    await wd.execute('window.__homeIdentity = "KEPT_HOME_FRAME";');
    await wd.frame(null); await clickText("별표·그룹 관리");
    const add = async (path: string, group: string) => {
      await wd.sendKeys(await wd.waitFor('textarea[aria-label="추가할 파일 경로"]'), path);
      const field = await wd.waitFor('input[aria-label="그룹 이름"]'); await wd.click(field);
      await wd.keys([{ type: "keyDown", value: "\uE009" }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: "\uE009" }]);
      await wd.sendKeys(field, group);
      if (await wd.execute('return arguments[0].value;', field) !== group) throw new Error("Group input was not entered");
      writeFileSync(ctx.report.path("home-input-" + group.slice(-1) + ".json"), JSON.stringify(await wd.execute('return {value:arguments[0].value, text:document.body.innerText};', field), null, 2));
      await clickText("별표에 추가");
      if (!await until(() => wd.execute<boolean>('return !document.querySelector("textarea[aria-label=\\"추가할 파일 경로\\"]").value;'))) throw new Error("Home reference add failed");
    };
    await add(source, "연구 A"); await add(other, "연구 B"); await clickText("자료에 질문"); await enter();
    writeFileSync(ctx.report.path("home-groups.json"), JSON.stringify({ library: await api("GET", "/api/office-knowledge"), groups: await wd.execute('return window.aiOffice.starredGroups();'), errors: await pageErrors(wd) }, null, 2));
    await wd.waitFor('.kb-ask-scope [role="radio"]', 15000); await clickText("연구 A", '.kb-ask-scope button');
    ctx.report.check(S, "첫 자료 추가 후 같은 홈에서 그룹 질문 사용", await wd.execute<boolean>('return window.__homeIdentity === "KEPT_HOME_FRAME" && !document.querySelector(".kb-ask-hero");'));
    await send("연구 A의 HOMEINFO를 읽고 새 Markdown 문서로 정리해 줘"); await finished("HOME_ANSWER_DONE");
    const first = JSON.stringify(requests.filter(request => request.phase === "answer"));
    const made = (await snapshot()).artifacts.find(artifact => artifact.workId === work.id && artifact.name === "생성답변 2.md");
    ctx.report.check(S, "원본 검색·읽기·문서 생성 도구와 현재 그룹 범위", !!made && readFileSync(made.path, "utf8").includes("HOME_CREATED_MD") && first.includes("HOME_PUBLIC_VALUE") && !first.includes("OTHER_GROUP_PRIVATE") && !first.includes("HOME_SECRET_VALUE"), undefined, await shot(ctx, "home-answer.png"));
    ctx.report.check(S, "기존 파일 보존·홈 때문에 메인 채팅 추가되지 않음", readFileSync(join(work.cwd, "생성답변.md"), "utf8") === "EXISTING_ANSWER" && (await snapshot()).sessions.filter(session => session.workId === work.id).length === 1 && (await items(main.id)).length === 0);
    const saveWord = await wd.execute<any>('return [...document.querySelectorAll(".kb-ask-action")].find(e=>/Word/.test(e.textContent));');
    if (!saveWord) throw new Error("Word answer save missing"); await wd.click(saveWord);
    let savedWord: Artifact | undefined;
    if (!await until(async () => { savedWord = (await snapshot()).artifacts.find(artifact => artifact.workId === work.id && artifact.format === "docx"); return !!savedWord; }, 60000)) throw new Error("Bundled answer DOCX conversion failed");
    const xml = await (await JSZip.loadAsync(readFileSync(savedWord!.path))).file("word/document.xml")!.async("string");
    ctx.report.check(S, "답변 Word 저장 버튼으로 실제 내장 CLI의 DOCX 생성", xml.includes("HOME_ANSWER_DONE"), undefined, await shot(ctx, "home-word-saved.png"));
    await wd.click(await wd.waitFor('.kb-ask-assistant a[href^="filenav:"]'));
    await wd.frame(null);
    const cited = (await snapshot()).artifacts.find(artifact => artifact.path === source);
    if (!cited) throw new Error("Citation artifact missing");
    await wd.frame(await wd.waitFor(`iframe.office-frame[src*=${JSON.stringify(`a=${cited.id}`)}]`, 30000));
    if (!await until(() => wd.execute<boolean>('return document.querySelector(".tiptap")?.textContent.includes("HOME_PUBLIC_VALUE");'), 30000)) throw new Error("Citation editor did not open");
    await open();
    ctx.report.check(S, "인용 문서 열기·홈 복귀에도 같은 질문과 답변 유지", await wd.execute<boolean>('return window.__homeIdentity === "KEPT_HOME_FRAME" && document.querySelector(".kb-ask-thread").textContent.includes("HOME_ANSWER_DONE");'), undefined, await shot(ctx, "home-return.png"));
    phase = "skills"; step = 0;
    skillId = (await wd.execute<OfficeSkillView[]>("return window.aiOfficeUserSkills.list();")).find(skill => skill.name === "native-home-reading")!.id;
    await pick("native-home-reading"); await send("스킬 자료를 읽고 재사용할 스킬로 제안해 줘"); await finished("HOME_SKILLS_DONE");
    const cardPath = join(ctx.app.dataDir, "user-skills/native-home-card/SKILL.md"); await wd.waitFor(".ai-skill-card", 15000);
    ctx.report.check(S, "홈의 원본 / 스킬 칩·자료 읽기·제안 카드", !existsSync(cardPath) && JSON.stringify(requests.filter(request => request.phase === "skills")).includes("HOME_SKILL_GUIDE"), undefined, await shot(ctx, "home-card.png"));
    const body = await wd.waitFor(".ai-skill-card-body"); await wd.click(body); await wd.sendKeys(body, " PERSON_CHANGED_HOME_CARD");
    const save = await wd.waitFor(".ai-skill-card .primary:not(:disabled)", 15000); await wd.execute('arguments[0].scrollIntoView({block:"center"});', save); await wd.click(save);
    if (!await until(() => wd.execute<boolean>('return !!document.querySelector("[data-skill-card-status=saved]");'))) throw new Error("Home card did not save");
    ctx.report.check(S, "명시적 카드 저장으로 편집한 스킬을 보관함에 보존", readFileSync(cardPath, "utf8").includes("PERSON_CHANGED_HOME_CARD") && (await items(main.id)).length === 0);
    phase = "template"; step = 0; await pick("native-home-template"); await send("이 양식의 사본에서 작업해 줘");
    let copy: Artifact | undefined, child: Session | undefined;
    if (!await until(async () => { const current = await snapshot(); copy = current.artifacts.find(artifact => artifact.workId === work.id && artifact.name === "native-home-template.docx"); child = current.sessions.find(session => session.documentAgent?.artifactId === copy?.id); return !!copy && !!child; }, 30000)) throw new Error("Home template child missing");
    await wd.frame(null); await wd.frame(await wd.waitFor(`iframe.office-frame[src*=${JSON.stringify(`a=${copy!.id}`)}]`, 30000));
    if (!await until(async () => (await items(child!.id)).some(item => item.kind === "turnEnd"), 60000)) throw new Error("Home template handoff did not run");
    const chat = await items(child!.id);
    const mainChat = await items(main.id), checks = { oneRequest: chat.filter(item => item.kind === "user").length === 1, completed: chat.some(item => item.kind === "turnEnd" && item.status === "completed"), parent: child!.documentAgent?.parentSessionId === main.id,
      noMainRequest: !mainChat.some(item => item.kind === "user" || item.kind === "assistant"), resultToMain: mainChat.some(item => item.kind === "notice" && item.text.includes("HOME_TEMPLATE_DONE")) };
    writeFileSync(ctx.report.path("home-template-transcripts.json"), JSON.stringify({ checks, child, chat, mainChat }, null, 2));
    ctx.report.check(S, "템플릿 사본의 독립 문서 대화로 요청을 한 번 인계하고 메인에 완료 알림", Object.values(checks).every(Boolean), JSON.stringify(checks), await shot(ctx, "home-template.png"));
    ctx.report.check(S, "자료 원문·양식 원본 보존", readFileSync(source, "utf8") === original && digest() === beforeTemplate);
    await open();
    ctx.report.check(S, "문서 작업 후 홈 대화·스킬 카드 유지와 페이지 예외 없음", await wd.execute<boolean>('return document.querySelector(".kb-ask-thread").textContent.includes("HOME_ANSWER_DONE") && !!document.querySelector("[data-skill-card-status=saved]");') && (await pageErrors(wd)).length === 0, JSON.stringify(await pageErrors(wd)));
    await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="지식베이스 닫기"]'));
  } catch (error) {
    writeFileSync(ctx.report.path("home-diagnostic.json"), JSON.stringify({ error: String(error), page: await wd.execute('return document.body.innerText.slice(-12000);').catch(() => null), requests }, null, 2));
    throw error;
  } finally {
    writeFileSync(ctx.report.path("home-requests.json"), JSON.stringify(requests, null, 2));
    await wd.frame(null); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  }
}
