import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";
const require = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument } = require("pdf-lib");

/** Original PDF job screens/engine/storage, using a local model fixture and synthetic documents. */
export async function pdfJobsScenario(ctx: Ctx) {
  const { wd, api } = ctx.app, S = "PDF 장기 AI 작업";
  let phase = "stop", translations = 0, cancelled = 0, chatClosed = false;
  let releaseChat: (() => void) | null = null;
  const requests: { phase: string; kind: string; tools: number; images: number; blocks: { id: string; text: string }[] }[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      const body = JSON.parse(raw), system = body.messages.filter((m: any) => m.role === "system").map((m: any) => String(m.content)).join("\n");
      const kind = system.includes("You are a translation engine.") ? "translation" : system.includes("You transcribe one page") ? "reading" : system.includes("You write an overview of a document") ? "overview" : "chat";
      const prompt = body.messages.filter((m: any) => m.role === "user").at(-1)?.content;
      const blocks = kind === "translation" ? JSON.parse(String(prompt).split("<document_blocks>\n")[1]!.split("\n</document_blocks>")[0]!).blocks : [];
      const images = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((part: any) => part.type === "image_url" && part.image_url?.url?.startsWith("data:image/")).length;
      requests.push({ phase, kind, blocks, tools: body.tools?.length ?? 0, images });
      const reply = () => {
        if (res.destroyed) return;
        const content = kind === "translation" ? JSON.stringify({ translations: blocks.map((b: { id: string; text: string }) => ({ id: b.id, text: "Translated " + b.text })) }) : kind === "reading" ? "<page-content>\n# Page reading\n\nPDF_READ_STORED from the page image.\n</page-content>" : kind === "overview" ? JSON.stringify({ summary3: ["First point", "Second point", "Third point"], summary: "PDF_OVERVIEW_STORED", terms: [{ term: "Page", meaning: "A page of this document", page: 1 }] }) : "PDF_CHAT_INDEPENDENT";
        res.setHeader("content-type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\n`); res.end("data: [DONE]\n\n");
      };
      if (kind === "translation") {
        translations++;
        if (phase === "stop" && translations > 1) { res.on("close", () => { cancelled++; }); return; }
      } else if (kind === "chat" && phase === "stop") { res.on("close", () => { chatClosed = true; }); releaseChat = reply; return; }
      reply();
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot"), pane = '.pane[data-tab-active="true"]';
  const office = async () => { await wd.frame(null); await wd.frame(await wd.waitFor(`${pane} iframe.office-frame`, 30000)); await wd.waitFor('.pdf-page[data-page="0"]', 30000); };
  const activate = async (el: Parameters<typeof wd.click>[0]) => {
    await wd.execute("arguments[0].focus();", el);
    await wd.keys([{ type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }]);
  };
  const command = async (name: string) => { const el = await wd.waitFor(`[data-action="${name}"]:not(:disabled)`, 30000); await wd.execute('arguments[0].scrollIntoView({block:"center"});', el); await wd.execute('return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));');
    if (await wd.execute<boolean>('return !!arguments[0].closest(".pdf-modal");', el)) await activate(el); else await wd.click(el);
  };
  const checkbox = async (name: string, checked: boolean) => {
    const el = await wd.waitFor(`[data-field="${name}"]`);
    if (await wd.execute<boolean>('return arguments[0].checked;', el) !== checked) { await wd.execute('arguments[0].focus();', el); await wd.keys([{ type: 'keyDown', value: ' ' }, { type: 'keyUp', value: ' ' }]); }
    if (!await until(() => wd.execute<boolean>('return document.querySelector(arguments[0])?.checked === arguments[1];', `[data-field="${name}"]`, checked), 5000)) throw new Error(`Checkbox ${name} did not change`);
  };
  const selectTab = async (id: string) => {
    const selector = `${pane} [data-tab-id="${id}"] [role=tab]`, tab = await wd.waitFor(selector);
    await wd.execute('arguments[0].focus();', tab);
    await wd.keys([{ type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }]);
    await wd.waitFor(`${selector}[aria-selected="true"]`, 15000);
  };
  const store = () => wd.execute<any>('return window.pdfApi.store.docHash(window.__pdfPath).then(h=>window.pdfApi.store.translation(h.docHash,"ko"));');
  try {
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "pdf-fixture";
    settings.customEndpoints = [{ id: "pdf-fixture", name: "Local PDF fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "pdf-model", kind: "local", modelProfiles: { "pdf-model": { tools: true, toolsSource: "user", vision: true, visionSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    const work = await api<Work>("POST", "/api/works", { title: "PDF 독립 작업", cwd: null });
    const main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
    const pdf = await PDFDocument.create();
    for (let p = 0; p < 20; p++) {
      const page = pdf.addPage([600, 800]);
      for (let line = 0; line < 20; line++) page.drawText(`Page ${p + 1} block ${line + 1}. ${"Original document text for the translation job. ".repeat(2)}`, { x: 25, y: 760 - line * 34, size: 9 });
    }
    const original = Buffer.from(await pdf.save()), file = join(work.cwd, "장기 작업 원본.pdf"); writeFileSync(file, original);
    const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
    const tab = { id: "pdf-job-tab", workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } };
    const home = { id: "pdf-job-main", workId: work.id, sessionId: main.id, view: { kind: "project", workId: work.id }, ui: {} };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "pdf-job-pane", panes: [{ ...tab, id: "pdf-job-pane", tabs: [home, tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd); await office(); await installProbe(wd);
    await wd.execute('window.__pdfPath = arguments[0]; window.__pdfKept = true;', file);
    await command("translate-open"); await wd.waitFor('[data-field="language"]', 30000);
    await checkbox("format-pdf", false); await checkbox("format-store", true); await command("next"); await wd.waitFor('.pdf-translate-dialog[data-step="confirm"]');
    ctx.report.check(S, "원본 구조 분석·언어·범위 선택과 실행 전 확인", requests.length === 0, undefined, await shot(ctx, "pdf-confirm.png"));
    await command("start");
    if (!await until(async () => translations >= 3, 45000)) throw new Error("Original PDF translation did not start multiple batches");
    await wd.frame(null); await selectTab("pdf-job-main");
    ctx.report.check(S, "메인 탭 선택에도 PDF 작업 유지·메인 세션 분리", (await snapshot()).sessions.find(s => s.id === main.id)?.status === "idle" && cancelled === 0);
    await selectTab("pdf-job-tab"); await office();
    ctx.report.check(S, "복귀 시 PDF 화면과 작업 유지", await wd.execute<boolean>('return window.__pdfKept && !!document.querySelector("[data-job-state=running]");'));
    const input = await wd.waitFor('.copilot textarea:not(:disabled)', 30000); await wd.click(input); await wd.sendKeys(input, "PDF 번역과 별도로 문서 질문을 처리해 줘"); await wd.click(await wd.waitFor('.ai-send-btn:not(.ai-stop-btn):not(:disabled)'));
    if (!await until(async () => releaseChat !== null, 30000)) throw new Error("PDF chat did not run beside translation");
    await command("stop-job"); await wd.waitFor('[data-job-state="stopped"]', 30000);
    ctx.report.check(S, "번역만 중지하고 문서 채팅은 유지", cancelled > 0 && !chatClosed);
    releaseChat!(); if (!await until(() => wd.execute<boolean>('return document.querySelector(".copilot")?.textContent.includes("PDF_CHAT_INDEPENDENT") && !document.querySelector(".ai-stop-btn");'), 30000)) throw new Error("PDF chat did not finish");
    const partial = await store(); writeFileSync(ctx.report.path("pdf-partial-store.json"), JSON.stringify(partial, null, 2));
    ctx.report.check(S, "중단 전 번역 결과 보관·원본 불변", partial.ok && partial.translation.blocks.length > 0 && readFileSync(file).equals(original));
    const firstTexts = requests.filter(r => r.kind === "translation")[0]!.blocks.map(b => b.text).sort(), before = translations;
    await wd.frame(null); await wd.refresh(); await installProbe(wd); await office(); await installProbe(wd); await wd.execute('window.__pdfPath = arguments[0];', file);
    await wd.waitFor('[data-resume-kind="translate"] [data-action="resume-job"]', 30000);
    ctx.report.check(S, "새 화면은 명시 재개를 제안하며 자동 호출하지 않음", translations === before);
    await command("resume-job"); await wd.waitFor('[data-field="language"]', 30000);
    for (const format of ["md", "epub", "pdf"]) await checkbox(`format-${format}`, true);
    await checkbox("bilingual", true); await command("next"); phase = "resume"; await command("start");
    const outputs = ["md", "epub", "pdf"].map(format => join(work.cwd, `대역 결과.${format}`));
    await wd.frame(null);
    for (let i = 0; i < 3; i++) {
      const selector = '.office-output-dialog input[aria-label="저장할 파일 경로"]', field = await wd.waitFor(selector, 30000);
      const current = await wd.execute<string>('return arguments[0].value;', field), format = current.split(".").at(-1)!;
      if (!["md", "epub", "pdf"].includes(format)) throw new Error(`Unexpected result format ${current}`);
      await wd.execute("arguments[0].focus();", field); await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]);
      await wd.sendKeys(field, join(work.cwd, `대역 결과.${format}`)); await activate(await wd.waitFor('.office-output-dialog button[type="submit"]'));
      await until(() => wd.execute<boolean>('const x=document.querySelector(arguments[0]); return !x || x.value!==arguments[1];', selector, join(work.cwd, `대역 결과.${format}`)), 15000);
    }
    await office();
    if (!await until(async () => outputs.every(existsSync), 120000)) throw new Error("PDF result files did not finish");
    await wd.waitFor('[data-action="close-report"]', 30000);
    const resumed = requests.filter(r => r.phase === "resume" && r.kind === "translation").flatMap(r => r.blocks.map(b => b.text));
    ctx.report.check(S, "보관된 첫 번역 묶음을 재호출하지 않음", !firstTexts.some(text => resumed.includes(text)));
    ctx.report.check(S, "장기 작업은 편집 도구 없이 원본 분할 모델 호출", requests.filter(r => r.kind !== "chat").every(r => r.tools === 0));
    const md = readFileSync(outputs[0]!, "utf8");
    ctx.report.check(S, "Markdown 대역에 원문·번역문 함께 보관", md.includes("Translated Page 1") && md.includes("Page 20 block"));
    const bilingualPdf = await PDFDocument.load(readFileSync(outputs[2]!));
    ctx.report.check(S, "대역 PDF가 각 장에 원문·번역을 좌우로 배치", bilingualPdf.getPageCount() === 20 && bilingualPdf.getPages().every((page: any) => page.getWidth() === 1200 && page.getHeight() === 800), `원본20장 → 대역${bilingualPdf.getPageCount()}장`);
    ctx.report.check(S, "EPUB 결과 생성", readFileSync(outputs[1]!).subarray(0, 2).toString() === "PK");
    const state = await snapshot(), child = state.sessions.find(s => s.documentAgent?.artifactId === artifact.id)!;
    const messages = (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${child.id}/items`)).items;
    ctx.report.check(S, "번역·질문은 독립 문서 대화에 기록", messages.filter(m => m.kind === "user").length === 3 && messages.some(m => m.kind === "assistant" && m.text.includes("PDF translate")));
    ctx.report.check(S, "출력 문서 등록·원본 파일/판 보존", state.artifacts.filter(a => outputs.includes(a.path)).length === 3 && readFileSync(file).equals(original) && state.artifacts.find(a => a.id === artifact.id)?.revision === 1);
    ctx.report.check(S, "원본 결과 보고·화면 예외 없음", !(await pageErrors(wd)).length, undefined, await shot(ctx, "pdf-report.png"));
    await command("close-report"); await wd.frame(null);
    if (!await until(() => wd.execute<boolean>(`return document.querySelector('${pane} .doc-name')?.textContent==='대역 결과.md';`), 30000)) throw new Error("Markdown result did not open");
    await wd.frame(await wd.waitFor(`${pane} iframe.office-frame`, 30000)); await wd.waitFor('.ProseMirror', 30000);
    if (!await until(() => wd.execute<boolean>('return document.querySelector(".ProseMirror")?.textContent.includes("Translated Page 1");'), 30000)) throw new Error("Markdown result body did not render");
    await wd.frame(null);
    ctx.report.check(S, "결과 Markdown을 문서 탭에서 열기", true, undefined, await shot(ctx, "pdf-result-open.png"));
    await selectTab("pdf-job-tab"); await office();
    await command("ai-read-menu"); await command("ai-read-open");
    const add = await wd.waitFor('.pdf-ai-read-add input:not(:disabled)', 30000);
    for (const check of await wd.findAll('.pdf-ai-read-pages input:checked:not(:disabled)')) {
      await wd.execute('arguments[0].focus();', check); await wd.keys([{ type: "keyDown", value: " " }, { type: "keyUp", value: " " }]);
    }
    await wd.sendKeys(add, "1"); await command("add-pages"); await command("next");
    await wd.waitFor('.pdf-ai-read-dialog[data-step="confirm"]', 30000); await command("start");
    await wd.waitFor('[data-job-kind="ai-read"][data-job-state="complete"]', 45000);
    const reading = await wd.execute<any>('return window.pdfApi.store.docHash(window.__pdfPath).then(h=>window.pdfApi.store.aiReadPages(h.docHash));');
    ctx.report.check(S, "원본 AI 페이지 읽기·실제 페이지 그림 전달·결과 보관", reading.ok && reading.pages.length === 1 && JSON.stringify(reading.pages).includes("PDF_READ_STORED") && requests.some(r => r.kind === "reading" && r.tools === 0 && r.images > 0));
    ctx.report.check(S, "AI 읽기는 PDF 원문 바이트·판을 바꾸지 않음", readFileSync(file).equals(original) && (await snapshot()).artifacts.find(a => a.id === artifact.id)?.revision === 1, undefined, await shot(ctx, "pdf-reading.png"));
    const overviewButton = await wd.waitFor('.ai-overview [data-action="create"]', 30000); await wd.click(overviewButton);
    if (!await until(() => wd.execute<boolean>('return document.querySelector(".ai-overview[data-state=ready]")?.textContent.includes("PDF_OVERVIEW_STORED");'), 30000)) throw new Error("Original PDF overview did not finish");
    const insight = await wd.execute<any>('return window.pdfApi.store.docHash(window.__pdfPath).then(h=>window.pdfApi.store.insights(h.docHash,"ko"));');
    ctx.report.check(S, "읽기 도우미의 별도 호출·세줄 요약/용어·원본 결과 보관", insight.ok && insight.insights?.summary === "PDF_OVERVIEW_STORED" && insight.insights?.summary3?.length === 3 && requests.some(r => r.kind === "overview" && r.tools === 0), undefined, await shot(ctx, "pdf-overview.png"));
    if (!await until(async () => (await snapshot()).sessions.find(s => s.id === child.id)?.status === "idle", 10000)) throw new Error("PDF reading helper left the document session running");
    const finalMessages = (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${child.id}/items`)).items;
    ctx.report.check(S, "읽기 도우미의 독립 대화 완료·메인 유휴·원문 보존", finalMessages.some(m => m.kind === "user" && m.text === "PDF 읽기 도우미 요청") && (await snapshot()).sessions.find(s => s.id === main.id)?.status === "idle" && readFileSync(file).equals(original));

  } catch (error) {
    writeFileSync(ctx.report.path("pdf-failure.json"), JSON.stringify({ error: String(error), body: await wd.execute('return document.body.innerText').catch(() => null), dialog: await wd.execute('return document.querySelector(".pdf-modal")?.outerHTML').catch(() => null), errors: await pageErrors(wd).catch(() => []) }, null, 2));
    await shot(ctx, "pdf-failure.png").catch(() => {}); throw error;
  } finally {
    writeFileSync(ctx.report.path("pdf-requests.json"), JSON.stringify({ requests, translations, cancelled, chatClosed }, null, 2));
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await wd.frame(null).catch(() => {});
  }
}
