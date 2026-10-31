import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import type { KnowledgeLibrary } from "../../packages/contracts/src/office-knowledge.ts";
import type { Layout } from "../../apps/web/src/panes.ts";
import { kbCiteHref } from "../../vendor/ieumoffice/packages/agent-core/src/knowledge-base-skill.ts";
import { installProbe, pageErrors, savedLayout, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

/** Real original KB skill/parser/editor; only the remote model response is synthetic. */
export async function officeKnowledgeScenario(ctx: Ctx) {
  const S = "Office 지식베이스", { wd, api } = ctx.app;
  const requests: any[] = [], marker = "KNOWLEDGE DOCUMENT EDIT";
  const outside = join(ctx.stage.outDir, "knowledge-library"); mkdirSync(outside, { recursive: true });
  const reference = join(outside, "공동 참고자료.md");
  const original = '---\r\n"DIKM_단계:": ""\r\ntags: [Workflow_Engineering]\r\nunknown: null\r\n---\r\n# 외부 참고자료\r\n\r\n지식탐색 NATIVE PUBLIC KNOWLEDGE\r\n\r\n<span class="redact-span" data-redaction="" data-label="가린 값">NATIVE_KNOWLEDGE_SECRET</span>\r\n';
  writeFileSync(reference, original);
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
      const body = JSON.parse(raw); requests.push(body);
      const step = requests.length;
      const calls = [
        { name: "search_knowledge_base", input: { query: "지식탐색", limit: 8 } },
        { name: "read_knowledge_file", input: { index: 0, offset: 0 } },
        { name: "insert_content", input: { html: `<p>${marker}</p>`, afterBlockIndex: -1 } },
      ];
      const call = calls[step - 1];
      if (call && !body.tools?.some((tool: any) => tool.function?.name === call.name)) throw new Error(`Original tool missing: ${call.name}`);
      if (step > 4) throw new Error("Unexpected knowledge model request");
      res.setHeader("content-type", "text/event-stream");
      const delta = call
        ? { role: "assistant", tool_calls: [{ index: 0, id: `knowledge-${step}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }
        : { role: "assistant", content: `자료를 읽고 문서를 수정했습니다. [공동 참고자료.md](${kbCiteHref(reference)})` };
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  let session: Session | undefined;
  const items = async () => session ? (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items : [];
  const clickText = async (text: string, scope = "button") => {
    const button = await wd.execute<any>('return [...document.querySelectorAll(arguments[1])].find(el=>el.textContent.trim()===arguments[0]);', text, scope);
    if (!button) throw new Error(`Button not found: ${text}`);
    await wd.execute('arguments[0].scrollIntoView({block:"center"});', button); await wd.click(button);
  };
  const openLibrary = async () => {
    await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]'));
    await clickText("지식베이스…"); await wd.waitFor('.knowledge-library[role="dialog"]');
  };
  const enter = async (contains: string, selector = ".tiptap") => {
    if (!await until(async () => {
      await wd.frame(null);
      for (const frame of await wd.findAll('[data-pane="knowledge-pane"] iframe.office-frame')) {
        if (!await wd.displayed(frame)) continue;
        await wd.frame(frame);
        return wd.execute<boolean>('return document.querySelector(arguments[1])?.textContent.includes(arguments[0]) === true;', contains, selector);
      }
      return false;
    }, 45000)) throw new Error(`Document not visible: ${contains}`);
  };
  try {
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "knowledge-fixture";
    settings.customEndpoints = [{ id: "knowledge-fixture", name: "Local knowledge fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "knowledge-model", kind: "local", modelProfiles: { "knowledge-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    const work = await api<Work>("POST", "/api/works", { title: "공유 지식으로 Word 작성", cwd: null });
    const file = join(work.cwd, "Knowledge.docx"); copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), file);
    const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
    const tab = { id: "knowledge-word", workId: work.id, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "knowledge-pane", panes: [{ ...tab, id: "knowledge-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1900, height: 1200 }); await wd.refresh(); await installProbe(wd);
    await openLibrary();
    await wd.sendKeys(await wd.waitFor('textarea[aria-label="추가할 파일 경로"]'), reference);
    await wd.sendKeys(await wd.waitFor('input[aria-label="그룹 이름"]'), "공유 연구"); await clickText("별표에 추가");
    const registered = await until(async () => (await api<KnowledgeLibrary>("GET", "/api/office-knowledge")).items.some(item => item.path === reference && item.group === "공유 연구") && await wd.execute<boolean>('return document.querySelector(".knowledge-list")?.textContent.includes("공동 참고자료.md") === true;'));
    ctx.report.check(S, "설정 메뉴에서 작업 폴더 밖 파일을 별표·그룹으로 등록", registered, undefined, await shot(ctx, "knowledge-library.png"));
    await wd.sendKeys(await wd.waitFor('input[aria-label="지식베이스 검색어"]'), "지식탐색"); await clickText("검색", ".knowledge-library button");
    const searched = await until(() => wd.execute<boolean>('return document.querySelector(".knowledge-list article")?.textContent.includes("지식탐색") === true;'));
    ctx.report.check(S, "원본 한글 FTS로 별표 파일 본문 검색", searched, undefined, await shot(ctx, "knowledge-search.png"));
    await wd.click(await wd.waitFor('button[aria-label="지식베이스 닫기"]'));
    await enter("", ".ai-panel"); await installProbe(wd);
    const input = await wd.waitFor('.ai-panel textarea:not(:disabled)', 30000);
    await wd.click(input); await wd.sendKeys(input, "지식베이스의 지식탐색 자료를 찾아 읽고 문서 첫머리에 정리해 줘. 출처도 달아 줘.");
    await wd.click(await wd.waitFor('.ai-send-btn:not(.ai-stop-btn):not(:disabled)'));
    if (!await until(async () => { session = (await snapshot()).sessions.find(item => item.workId === work.id); return !!session; }, 20000)) throw new Error("No knowledge conversation");
    if (!await until(async () => (await items()).some(item => item.kind === "turnEnd"), 60000)) throw new Error("Knowledge conversation did not finish");
    const transcript = await items(), toolItems = transcript.filter(item => item.kind === "tool");
    const outputs = toolItems.map(item => item.output ?? "").join("\n");
    const completed = transcript.some(item => item.kind === "turnEnd" && item.status === "completed");
    ctx.report.check(S, "원본 Word AI가 검색→페이지 읽기→문서 편집 도구 실행", completed && toolItems.length === 3 && toolItems.every(item => item.status === "completed") && outputs.includes("NATIVE PUBLIC KNOWLEDGE"), outputs.slice(-1800));
    ctx.report.check(S, "가린 값은 검색·읽기·모델 전달에서 제외", outputs.includes("{{가린 값}}") && !JSON.stringify(requests).includes("NATIVE_KNOWLEDGE_SECRET"));
    const xml = await (await JSZip.loadAsync(readFileSync(file))).file("word/document.xml")!.async("string");
    ctx.report.check(S, "원본 편집 결과 DOCX 저장·같은 대화에 검색과 인용 기록", xml.includes(marker) && requests.length === 4 && (await snapshot()).sessions.filter(item => item.workId === work.id).length === 1 && transcript.some(item => item.kind === "assistant" && item.text.includes("filenav://")), undefined, await shot(ctx, "knowledge-word.png"));
    const citation = await wd.waitFor('.ai-panel a[href^="filenav:"]'); await wd.click(citation);
    await enter("외부 참고자료"); await installProbe(wd);
    const opened = (await snapshot()).artifacts.find(item => item.path === reference);
    const scoped = await until(async () => {
      const layout = (await savedLayout(ctx))?.layout as Layout<{ kind: string; artifactId?: string }> | undefined;
      return layout?.panes.some(pane => pane.tabs?.some(tab => tab.view.kind === "document" && tab.view.artifactId === opened?.id && tab.sessionId === null)) === true;
    });
    ctx.report.check(S, "인용 클릭으로 외부 자료를 별도 작업공간에서 열기", !!opened && opened.workspaceId !== session!.workspaceId && scoped, undefined, await shot(ctx, "knowledge-citation.png"));
    const sourceErrors = await pageErrors(wd); await wd.frame(null);
    await wd.click(await wd.waitFor('[data-pane="knowledge-pane"][data-tab-active="true"] [data-tab-id="knowledge-word"] [role="tab"]'));
    await enter(marker);
    ctx.report.check(S, "원래 Word 탭으로 돌아오면 같은 대화·인용 유지", await wd.execute<boolean>('return document.querySelector(".ai-panel")?.textContent.includes("자료를 읽고 문서를 수정했습니다") === true;') && (await items()).filter(item => item.kind === "turnEnd").length === 1);
    ctx.report.check(S, "자료 원문 YAML·CRLF·전체 바이트 보존", readFileSync(reference, "utf8") === original);
    const wordErrors = await pageErrors(wd); await wd.frame(null); await wd.refresh(); await installProbe(wd); await openLibrary();
    ctx.report.check(S, "앱 화면 재열기 후 별표·그룹 복원", await until(() => wd.execute<boolean>('return document.querySelector(".knowledge-list")?.textContent.includes("공동 참고자료.md") === true;')) && (await api<KnowledgeLibrary>("GET", "/api/office-knowledge")).groups.includes("공유 연구"));
    await wd.click(await wd.waitFor('input[aria-label="선택 공동 참고자료.md"]')); await clickText("별표 해제");
    const removed = await until(async () => (await api<KnowledgeLibrary>("GET", "/api/office-knowledge")).items.length === 0);
    ctx.report.check(S, "별표 해제가 원본 파일을 삭제하지 않음", removed && readFileSync(reference, "utf8") === original);
    ctx.report.check(S, "등록·검색·인용·문서 편집 중 페이지 예외 없음", sourceErrors.length === 0 && wordErrors.length === 0 && (await pageErrors(wd)).length === 0, JSON.stringify([...sourceErrors, ...wordErrors, ...await pageErrors(wd)]));
  } catch (error) {
    ctx.report.check(S, "지식베이스 실제 앱 검증", false, error instanceof Error ? error.stack : String(error), await shot(ctx, "knowledge-failed.png").catch(() => null));
    try { writeFileSync(ctx.report.path("knowledge-diagnostic.json"), JSON.stringify(await wd.execute('return {text:document.body.innerText.slice(-8000), errors:window.__wbProbe?.errors};'), null, 2)); } catch {}
  } finally {
    writeFileSync(ctx.report.path("knowledge-requests.json"), JSON.stringify(requests, null, 2));
    writeFileSync(ctx.report.path("knowledge-transcript.json"), JSON.stringify(await items(), null, 2));
    const current = await snapshot();
    writeFileSync(ctx.report.path("knowledge-routing.json"), JSON.stringify({
      artifacts: current.artifacts.map(({ id, path, workId, workspaceId }) => ({ id, path, workId, workspaceId })),
      sessions: current.sessions.map(({ id, workId, workspaceId }) => ({ id, workId, workspaceId })),
      layout: (await savedLayout(ctx))?.layout,
    }, null, 2));
    await wd.frame(null).catch(() => {}); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  }
}
