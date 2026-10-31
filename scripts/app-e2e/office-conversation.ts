import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { officeUndo } from "./office-undo.ts";

/** A synthetic model supplies one original Docs tool call. All UI, editing, saving,
 * ownership and history paths are the real shipped app, with no paid model calls. */
export async function officeConversationScenario(ctx: Ctx) {
  const S = "Office 같은 세션", { wd, api } = ctx.app;
  const unbound = process.env.APP_E2E_OFFICE_UNBOUND === "1";
  const web = process.env.APP_E2E_OFFICE_WEB === "1";
  const media = process.env.APP_E2E_OFFICE_MEDIA === "1";
  if (web && media) throw new Error("Choose either the web or media conversation experiment");
  const { PNG } = createRequire(import.meta.url)("pngjs");
  const png = PNG.sync.write({ width: 96, height: 64, data: Buffer.alloc(96 * 64 * 4, Buffer.from([0, 120, 135, 255])) }).toString("base64");
  const mediaRequests: { url: string; authorized: boolean; body: any }[] = [];
  const requests: any[] = [];
  let cancelledStreams = 0;
  const marker = "WORKBENCH OFFICE NATIVE TOOL EDIT";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += String(part);
    if (media && req.url?.startsWith("/media/v1/")) {
      mediaRequests.push({ url: req.url, authorized: req.headers.authorization === "Bearer media-fixture-key", body: JSON.parse(raw) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url.endsWith("/images/generations") ? { data: [{ b64_json: png }] } : { choices: [{ message: { content: "NATIVE_MEDIA_ANALYZED_TEAL_RECTANGLE" } }] })); return;
    }
    if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture-panel-model" }] })); return; }
    if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
    const body = JSON.parse(raw); requests.push(body);
    res.setHeader("content-type", "text/event-stream");
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture-panel", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (raw.includes("__native_cancel__")) {
      send({ role: "assistant", content: "취소 전에 받은 부분 답변" });
      const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 30000);
      res.once("close", () => { clearTimeout(timer); if (!res.writableEnded) cancelledStreams++; });
      return;
    }
    if (media && requests.length <= 3) {
      const block = /use analyze_media with blockIndex (\d+)/.exec(raw);
      const name = requests.length === 1 ? "generate_image" : requests.length === 2 ? "get_document_context" : "analyze_media";
      const input = requests.length === 1 ? { prompt: "A small teal rectangle", aspectRatio: "3:2" } : requests.length === 2 ? {} : { blockIndex: Number(block?.[1] ?? -1), requirements: "Describe the generated picture" };
      send({ role: "assistant", tool_calls: [{ index: 0, id: `native-media-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }); send({}, "tool_calls");
    } else if (web && requests.length === 1) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: "native-web-read", type: "function", function: { name: "read_url", arguments: JSON.stringify({ url: "https://example.com" }) } }] });
      send({}, "tool_calls");
    } else if (requests.length === (media ? 4 : web ? 2 : 1)) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: "native-docs-edit", type: "function", function: { name: "insert_content", arguments: JSON.stringify({ html: `<p>${marker}</p>`, afterBlockIndex: -1 }) } }] });
      send({}, "tool_calls");
    } else { send({ role: "assistant", content: "같은 세션에 문서 수정 완료" }); send({}, "stop"); }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No model fixture port");
  try {
    const work = await api<Work>("POST", "/api/works", { title: "문서와 같은 AI 세션", cwd: null });
    let session = unbound ? undefined : await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
    const file = join(work.cwd, "같은 세션.docx");
    copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), file);
    const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "panel-fixture";
    settings.customEndpoints = [{ id: "panel-fixture", name: "Local panel fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "fixture-panel-model", kind: "local", modelProfiles: { "fixture-panel-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    if (media) settings.media = { imageProvider: "openai", analysisProvider: "openai", providers: { openai: { apiKey: "media-fixture-key", imageModel: "gpt-image-1", analysisModel: "gpt-4o", baseUrl: `http://127.0.0.1:${address.port}/media/v1` } } };
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
    const items = async (id = session?.id) => id ? (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items : [];
    const tab = { id: "office-conversation-tab", workId: work.id, sessionId: session?.id ?? null, view: { kind: "document", artifactId: artifact.id, proposalId: null } };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "office-conversation-pane", panes: [{ ...tab, id: "office-conversation-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
    const frame = await wd.waitFor("iframe.office-frame", 30000); await wd.frame(frame); await installProbe(wd);
    await wd.waitFor('.tiptap[contenteditable="true"]', 60000);
    const input = await wd.waitFor(".ai-panel textarea", 15000);
    if (media) await wd.execute('window.__mediaCapabilityProbe = {started:Date.now()}; window.desktop.aiToolCapabilities().then(value => Object.assign(window.__mediaCapabilityProbe,{value,done:Date.now()}), error => Object.assign(window.__mediaCapabilityProbe,{error:String(error),done:Date.now()}));');
    ctx.report.check(S, "Electron 없이 원본 Word AI 패널·모델 선택기 열기", !!input && !!await wd.find(".ai-panel .ai-send-btn"), undefined, await shot(ctx, "office-conversation-open.png"));
    if (unbound) {
      ctx.report.check(S, "세션 없이 문서를 열어도 불필요한 대화를 만들지 않음", (await snapshot()).sessions.every((item) => item.workId !== work.id));
      await wd.execute('window.__firstOfficeComposer = arguments[0]; window.__firstOfficeEditor = document.querySelector(".tiptap");', input);
    }
    await wd.click(input);
    writeFileSync(join(ctx.stage.outDir, "office-conversation-input.json"), JSON.stringify(await wd.execute('return {inputs: [...document.querySelectorAll(".ai-panel textarea")].map(el => ({disabled:el.disabled,hidden:el.hidden,rect:el.getBoundingClientRect().toJSON(),style:getComputedStyle(el).display,inert:!!el.closest("[inert]"),active:document.activeElement === el})),active:document.activeElement?.outerHTML};')));
    await wd.sendKeys(input, "문서 처음에 검사 문단을 넣어 줘");
    await wd.click(await wd.waitFor(".ai-panel .ai-send-btn:not(.ai-stop-btn)"));
    if (unbound) {
      if (!await until(async () => (await snapshot()).sessions.some((item) => item.workId === work.id), 15000)) throw new Error(`First Office session was not created: ${await wd.execute('return document.body.innerText.slice(-3500)')}`);
      session = (await snapshot()).sessions.find((item) => item.workId === work.id);
    }
    if (!session) throw new Error("No Office conversation session");
    await until(async () => (await items()).some((item) => item.kind === "turnEnd"), 45000);
    const transcript = await items();
    const finished = transcript.some((item) => item.kind === "turnEnd" && item.status === "completed");
    if (unbound) ctx.report.check(S, "첫 요청이 만든 한 세션에 정확히 한 번 기록·채팅 입력창과 문서 유지", finished && (await snapshot()).sessions.filter((item) => item.workId === work.id).length === 1 && transcript.filter((item) => item.kind === "user" && item.text === "문서 처음에 검사 문단을 넣어 줘").length === 1 && await wd.execute<boolean>('return window.__firstOfficeComposer === document.querySelector(".ai-panel textarea") && window.__firstOfficeEditor === document.querySelector(".tiptap");'));
    writeFileSync(join(ctx.stage.outDir, "office-conversation-transcript.json"), JSON.stringify(transcript, null, 2));
    writeFileSync(join(ctx.stage.outDir, "office-conversation-model-requests.json"), JSON.stringify(requests, null, 2));
    const body = await wd.execute<string>("return document.body.innerText;");
    if (!finished) { await shot(ctx, "office-conversation-failed.png"); throw new Error(`Original panel did not finish: ${body.slice(-5000)}`); }
    const tool = transcript.find((item) => item.kind === "tool");
    const xml = await (await JSZip.loadAsync(readFileSync(file))).file("word/document.xml")!.async("string");
    ctx.report.check(S, "원본 편집 도구가 실제 DOCX를 수정하고 새 판으로 저장", tool?.kind === "tool" && tool.status === "completed" && xml.includes(marker) && (await snapshot()).artifacts.find((item) => item.id === artifact.id)!.revision > 1);
    ctx.report.check(S, "요청·편집 도구·응답·완료가 선택한 Workbench 세션에 함께 기록", transcript.some((item) => item.kind === "user" && item.office?.artifactId === artifact.id) && transcript.some((item) => item.kind === "assistant" && item.text.includes("수정 완료") && item.office?.artifactId === artifact.id) && requests.length === (media ? 5 : web ? 3 : 2), undefined, await shot(ctx, "office-conversation-completed.png"));
    if (media) {
      writeFileSync(join(ctx.stage.outDir, "office-media-capabilities.json"), JSON.stringify(await wd.execute('return window.__mediaCapabilityProbe;'), null, 2));
      const visible = await shot(ctx, "office-media-visible.png"), pixels = PNG.sync.read(readFileSync(visible));
      let teal = 0;
      for (let i = 0; i < pixels.data.length; i += 4) if (pixels.data[i] === 0 && pixels.data[i + 1] === 120 && pixels.data[i + 2] === 135) teal++;
      ctx.report.check(S, "생성 그림이 실제 Word 화면에 표시됨", teal > 1000, `${teal} teal pixels`, visible);
      const zip = await JSZip.loadAsync(readFileSync(file));
      const images = await Promise.all(Object.values(zip.files).filter(entry => entry.name.startsWith("word/media/") && !entry.dir).map(entry => entry.async("base64")));
      writeFileSync(join(ctx.stage.outDir, "office-media-provider-requests.json"), JSON.stringify(mediaRequests, null, 2));
      ctx.report.check(S, "원본 생성 엔진→제한된 임시 저장소→그림 삽입→DOCX 이미지 바이트 저장", mediaRequests[0]?.url.endsWith("/images/generations") === true && images.includes(png));
      ctx.report.check(S, "문서 안 그림 블록을 원본 미디어 분석기로 읽고 같은 모델 후속에 전달", mediaRequests.length === 2 && mediaRequests.every(request => request.authorized) && JSON.stringify(mediaRequests[1]?.body).includes(png) && JSON.stringify(requests[3]).includes("NATIVE_MEDIA_ANALYZED_TEAL_RECTANGLE") && transcript.some(item => item.kind === "tool" && item.status === "completed" && item.output?.includes("NATIVE_MEDIA_ANALYZED_TEAL_RECTANGLE")));
    }
    if (web) ctx.report.check(S, "원본 웹 읽기 도구가 실제 공개 페이지 본문을 같은 세션과 모델 후속에 전달", transcript.some(item => item.kind === "tool" && item.status === "completed" && item.output?.includes("Example Domain")) && JSON.stringify(requests[1]).includes("Example Domain"));
    if (process.env.APP_E2E_OFFICE_UNDO === "1") await officeUndo(ctx, "docx", artifact.id, marker, async () => (await JSZip.loadAsync(readFileSync(file))).file("word/document.xml")!.async("string"));
    const firstErrors = await pageErrors(wd); await wd.frame(null); await wd.refresh(); await installProbe(wd);
    await wd.frame(await wd.waitFor("iframe.office-frame", 30000)); await installProbe(wd);
    ctx.report.check(S, "문서 재열기에서 같은 세션의 대화와 편집 결과 복원", await until(() => wd.execute<boolean>('return document.querySelector(".ai-panel")?.textContent.includes("수정 완료") === true && document.querySelector(".tiptap")?.textContent.includes(arguments[0]) === true;', marker), 30000));
    await wd.execute('document.querySelector(".tiptap").dataset.sessionKept = "yes";');
    await wd.click(await wd.waitFor('.ai-header-btn[aria-label*="새 대화"]', 15000));
    const created = await until(async () => (await snapshot()).sessions.filter((item) => item.workId === work.id).length === 2, 10000);
    const next = (await snapshot()).sessions.find((item) => item.workId === work.id && item.id !== session.id)!;
    ctx.report.check(S, "원본 새 대화가 Workbench 새 세션을 만들고 문서 편집기 유지", created && !!next && await until(() => wd.execute<boolean>('return window.workbenchOfficeAi.snapshot() === arguments[0] && document.querySelector(".tiptap")?.dataset.sessionKept === "yes";', next.id)));
    const nextInput = await wd.waitFor(".ai-panel textarea"); await wd.click(nextInput);
    await wd.sendKeys(nextInput, "새 세션 확인"); await wd.click(await wd.waitFor(".ai-panel .ai-send-btn:not(.ai-stop-btn)"));
    ctx.report.check(S, "다음 요청은 새 세션에만 기록되고 이전 이력 보존", await until(async () => (await items(next.id)).some((item) => item.kind === "turnEnd" && item.status === "completed"), 30000) && (await items()).length === transcript.length, undefined, await shot(ctx, "office-conversation-new-session.png"));
    const cancelInput = await wd.waitFor(".ai-panel textarea"); await wd.click(cancelInput);
    await wd.sendKeys(cancelInput, "__native_cancel__ 취소 검사"); await wd.click(await wd.waitFor(".ai-panel .ai-send-btn:not(.ai-stop-btn)"));
    if (!await until(async () => (await items(next.id)).some((item) => item.kind === "assistant" && item.text.includes("부분 답변")), 10000)) throw new Error("Partial response did not reach the same Workbench session");
    await wd.click(await wd.waitFor(".ai-panel .ai-stop-btn"));
    ctx.report.check(S, "원본 중지 버튼이 실제 제공자 요청을 취소하고 같은 세션에 부분 답변 보존", await until(async () => cancelledStreams === 1 && (await items(next.id)).some((item) => item.kind === "turnEnd" && item.status === "interrupted"), 10000) && (await items(next.id)).some((item) => item.kind === "assistant" && item.text.includes("부분 답변")), undefined, await shot(ctx, "office-conversation-cancelled.png"));
    writeFileSync(join(ctx.stage.outDir, "office-conversation-new-transcript.json"), JSON.stringify(await items(next.id), null, 2));
    ctx.report.check(S, "문서 AI 조작 중 페이지 예외 없음", firstErrors.length === 0 && (await pageErrors(wd)).length === 0);
    await wd.frame(null);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}
