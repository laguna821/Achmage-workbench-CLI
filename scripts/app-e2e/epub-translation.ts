import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import JSZip from "jszip";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { epubFixture, epubEntry } from "./epub-fixture.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

/** Original book job/store/serializers and visible UI; only the model endpoint is a fixture. */
export async function epubTranslationScenario(ctx: Ctx) {
  const { wd, api } = ctx.app, S = "EPUB 전체 번역";
  let phase = "stop", translationCalls = 0, closedTranslations = 0, chatClosed = false;
  let releaseChat: (() => void) | null = null;
  const requests: { phase: string; translation: boolean; blocks: { id: string; text: string }[]; tools: number }[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
      const body = JSON.parse(raw), translation = body.messages.some((m: any) => m.role === "system" && String(m.content).includes("You are a translation engine."));
      const prompt = body.messages.filter((m: any) => m.role === "user").at(-1)?.content;
      const blocks = translation ? JSON.parse(String(prompt).split("<document_blocks>\n")[1]!.split("\n</document_blocks>")[0]!).blocks : [];
      requests.push({ phase, translation, blocks, tools: body.tools?.length ?? 0 });
      const reply = () => {
        if (res.destroyed) return;
        const content = translation ? JSON.stringify({ translations: blocks.map((b: { id: string; text: string }) => ({ id: b.id, text: "번역 " + b.text })) }) : "BOOK_CHAT_INDEPENDENT";
        res.setHeader("content-type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      if (translation) {
        translationCalls++;
        if (phase === "stop" && translationCalls > 1) { res.on("close", () => { closedTranslations++; }); return; }
      } else if (phase === "stop") {
        res.on("close", () => { chatClosed = true; }); releaseChat = reply; return;
      }
      reply();
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  const pane = '.pane[data-tab-active="true"]';
  const office = async () => { await wd.frame(null); await wd.frame(await wd.waitFor(`${pane} iframe.office-frame`, 30000)); await wd.waitFor("iframe.epub-frame", 30000); };
  const command = async (name: string) => { const el = await wd.waitFor(`[data-action="${name}"]:not(:disabled)`, 30000); await wd.execute('arguments[0].scrollIntoView({block:"center"});', el); await wd.click(el); };
  const destination = async (path: string) => {
    await wd.frame(null);
    const field = await wd.waitFor('.office-output-dialog input[aria-label="저장할 파일 경로"]', 30000);
    await wd.click(field); await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]);
    await wd.sendKeys(field, path); await wd.click(await wd.waitFor('.office-output-dialog button[type="submit"]')); await office();
    if (!await until(() => wd.execute<boolean>('return [...document.querySelectorAll("[data-location]")].some(e=>e.dataset.location===arguments[0]);', path), 15000)) throw new Error("Output selection was not received");
  };
  const stored = () => wd.execute<any>('return window.epubApi.documentHash().then(h=>window.epubApi.store.translation(h.docHash,"ko"));');
  try {
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "book-fixture";
    settings.customEndpoints = [{ id: "book-fixture", name: "Local book fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "book-model", kind: "local", modelProfiles: { "book-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    const work = await api<Work>("POST", "/api/works", { title: "전자책 장기 번역", cwd: null });
    const main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
    const zip = await JSZip.loadAsync(await epubFixture());
    const extra = Array.from({ length: 12 }, (_, i) => `<p id="long-${i}">BLOCK_${i} ${"Long book translation paragraph. ".repeat(120)}</p>`).join("\r\n");
    zip.file("OEBPS/text/one.xhtml", (await zip.file("OEBPS/text/one.xhtml")!.async("string")).replace("</body>", extra + "</body>"));
    const original = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), file = join(work.cwd, "전체 번역 원문.epub"); writeFileSync(file, original);
    const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
    const tab = { id: "book-tab", workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } };
    const home = { id: "book-main", workId: work.id, sessionId: main.id, view: { kind: "project", workId: work.id }, ui: {} };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "book-pane", panes: [{ ...tab, id: "book-pane", tabs: [home, tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd); await office(); await installProbe(wd);
    await wd.execute('window.__bookFrame="KEPT_BOOK";');
    const translated = join(work.cwd, "한국어 번역.epub"), bilingual = join(work.cwd, "한국어 대역.epub");
    const choose = async () => {
      await wd.waitFor('[data-field="language"]', 30000);
      if (await wd.execute<string>('return document.querySelector("[data-field=language]").value;') !== "ko") throw new Error("Expected original default Korean target");
      await wd.click(await wd.waitFor('[data-field="kind-bilingual"]'));
      await command("pick-translated"); await destination(translated);
      await command("pick-bilingual"); await destination(bilingual);
      await command("next"); await wd.waitFor('[data-step="confirm"]', 30000);
    };
    await command("translate-book"); await choose();
    ctx.report.check(S, "원본 언어·장·번역본/대역본 선택과 호출 확인", requests.length === 0, undefined, await shot(ctx, "book-confirm.png"));
    await command("start");
    if (!await until(async () => translationCalls >= 3, 45000)) throw new Error("Original job did not request multiple batches");
    ctx.report.check(S, "원본 번역 작업에 도구 없는 별도 모델 요청", requests.filter(r => r.translation).every(r => r.tools === 0));
    await wd.frame(null); await wd.click(await wd.waitFor('[data-tab-id="book-main"] [role=tab]'));
    ctx.report.check(S, "메인 탭으로 돌아가도 책 번역 유지", (await snapshot()).sessions.find(s => s.id === main.id)?.status === "idle" && closedTranslations === 0);
    await wd.click(await wd.waitFor('[data-tab-id="book-tab"] [role=tab]')); await office();
    ctx.report.check(S, "문서 탭 복귀가 원본 번역 화면을 다시 만들지 않음", await wd.execute<boolean>('return window.__bookFrame==="KEPT_BOOK" && !!document.querySelector("[data-job-state=running]");'));
    const input = await wd.waitFor('.copilot textarea:not(:disabled)', 30000); await wd.click(input); await wd.sendKeys(input, "번역과 별도로 책에 관한 질문을 처리해 줘");
    await wd.click(await wd.waitFor('.ai-send-btn:not(.ai-stop-btn):not(:disabled)', 30000));
    if (!await until(async () => releaseChat !== null, 30000)) throw new Error("Independent chat did not start beside book job");
    await command("stop-job"); await wd.waitFor('[data-job-state="stopped"]', 30000);
    ctx.report.check(S, "책 번역만 중지하고 같은 문서 채팅은 계속 실행", closedTranslations > 0 && !chatClosed);
    releaseChat!();
    if (!await until(() => wd.execute<boolean>('return document.querySelector(".copilot")?.textContent.includes("BOOK_CHAT_INDEPENDENT") && !document.querySelector(".ai-stop-btn");'), 30000)) throw new Error("Independent chat did not finish");
    const savedPartial = await stored(); writeFileSync(ctx.report.path("book-partial-store.json"), JSON.stringify(savedPartial, null, 2));
    const units = await wd.execute<any>('return window.epubApi.translationUnits({});');
    const keyOf = (key: Record<string, unknown>) => JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b)));
    const savedKeys = new Set(savedPartial.translation?.blocks.map((b: any) => keyOf(b.key)));
    const remainingTexts = units.units.filter((u: any) => !savedKeys.has(keyOf(u.key))).map((u: any) => u.text).sort();
    ctx.report.check(S, "번역 중단 후 완성된 블록은 보관하고 원문 보존", savedPartial.ok && savedKeys.size > 0 && remainingTexts.length > 0 && readFileSync(file).equals(original), undefined, await shot(ctx, "book-stopped.png"));
    const beforeResume = translationCalls;
    await wd.frame(null); await wd.refresh(); await installProbe(wd); await office(); await installProbe(wd);
    await wd.waitFor('[data-action="resume-job"]', 30000);
    ctx.report.check(S, "새 화면에서 중단 작업을 제안하고 자동 재호출하지 않음", translationCalls === beforeResume);
    await command("resume-job"); await choose(); phase = "resume"; await command("start");
    if (!await until(async () => existsSync(translated) && existsSync(bilingual), 120000)) throw new Error("Result EPUB books did not finish");
    await wd.waitFor('[data-action="close-report"]', 30000);
    const resumedTexts = requests.filter(r => r.phase === "resume" && r.translation).flatMap(r => r.blocks.map(b => b.text)).sort();
    ctx.report.check(S, "재개 시 이미 보관한 블록을 다시 요청하지 않음", JSON.stringify(resumedTexts) === JSON.stringify(remainingTexts));
    for (const [kind, target] of [["translated", translated], ["bilingual", bilingual]] as const) {
      const xml = (await epubEntry(readFileSync(target), "OEBPS/text/one.xhtml"))!.toString();
      ctx.report.check(S, `${kind}: 실제 번역 글·알 수 없는 원본 부속 파일 보존`, xml.includes("번역 First paragraph.") && (await epubEntry(readFileSync(target), "future/unknown.bin"))!.equals((await epubEntry(original, "future/unknown.bin"))!));
      if (kind === "bilingual") ctx.report.check(S, "대역본에 원문과 번역문 함께 보관", xml.includes('<p id="p1">First paragraph.</p>') && xml.includes("번역 First paragraph."));
      copyFileSync(target, ctx.report.path(`book-${kind}.epub`));
    }
    const state = await snapshot(), child = state.sessions.find(s => s.documentAgent?.artifactId === artifact.id)!;
    const childItems = await items(child.id), mainItems = await items(main.id);
    ctx.report.check(S, "번역·문서 질문은 독립 문서 대화에 기록", childItems.filter(i => i.kind === "user").length === 3 && childItems.some(i => i.kind === "assistant" && i.text.includes("전자책 번역 완료")) && !mainItems.some(i => i.kind === "user"));
    ctx.report.check(S, "두 결과를 문서로 등록하고 원문 파일·판 보존", state.artifacts.filter(a => a.path === translated || a.path === bilingual).length === 2 && readFileSync(file).equals(original) && state.artifacts.find(a => a.id === artifact.id)?.revision === artifact.revision);
    ctx.report.check(S, "원본 완료 보고와 화면 예외 없음", !(await pageErrors(wd)).length, undefined, await shot(ctx, "book-completed.png"));
    await wd.click(await wd.waitFor('[data-output="bilingual"] [data-action="open-result"]')); await wd.frame(null);
    if (!await until(() => wd.execute<boolean>(`return document.querySelector('${pane} .doc-name')?.textContent==='한국어 대역.epub';`), 30000)) throw new Error("Result book did not open in document tab");
    await office(); await wd.frame(await wd.waitFor("iframe.epub-frame"));
    ctx.report.check(S, "대역 결과책을 실제 편집기에서 다시 열기", await wd.execute<boolean>('return document.body.textContent.includes("번역 First paragraph.") && document.body.textContent.includes("First paragraph.");'), undefined, await shot(ctx, "book-result-open.png"));
    await wd.frame(null); ctx.report.check(S, "상위 앱 예외 없음", !(await pageErrors(wd)).length);
  } catch (error) {
    writeFileSync(ctx.report.path("book-failure.json"), JSON.stringify({ phase, error: String(error), body: await wd.execute('return document.body.innerText').catch(() => null), errors: await pageErrors(wd).catch(() => []) }, null, 2));
    await shot(ctx, "book-failure.png").catch(() => {}); throw error;
  } finally {
    writeFileSync(ctx.report.path("book-requests.json"), JSON.stringify({ requests, translationCalls, closedTranslations, chatClosed }, null, 2));
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await wd.frame(null).catch(() => {});
  }
}
