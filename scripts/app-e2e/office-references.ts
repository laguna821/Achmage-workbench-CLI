import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { fixture } from "./office-suite.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

/** Original @ UI + original read_attachment + the real parser. Only the remote model is a fixture. */
export async function officeReferencesScenario(ctx: Ctx) {
  const { wd, api } = ctx.app;
  const formats = ["pptx", "docx", "xlsx", "html", "hwpx", "xmind", "epub"] as const;
  const chosen = process.env.APP_E2E_OFFICE_REFERENCE_FORMATS?.split(",") ?? [...formats];
  if (chosen.some((format) => !(formats as readonly string[]).includes(format))) throw new Error("Unknown reference format");
  let requests: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
      const body = JSON.parse(raw); requests.push(body);
      res.setHeader("content-type", "text/event-stream");
      const send = (delta: unknown, finish_reason: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (body.messages.at(-1)?.role !== "tool") {
        if (!body.tools?.some((tool: any) => tool.function?.name === "read_attachment")) throw new Error("Original read_attachment tool missing");
        send({ role: "assistant", tool_calls: [{ index: 0, id: `reference-${requests.length}`, type: "function", function: { name: "read_attachment", arguments: '{"index":0}' } }] }, "tool_calls");
      } else send({ role: "assistant", content: "REFERENCE_READ_COMPLETE" }, "stop");
      res.end("data: [DONE]\n\n");
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No reference fixture port");
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const items = async (sessionId: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items;
  try {
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "reference-fixture";
    settings.customEndpoints = [{ id: "reference-fixture", name: "Local reference fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "reference-model", kind: "local", modelProfiles: { "reference-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    for (const format of chosen as (typeof formats)[number][]) {
      const S = `Office 참조 ${format}`; requests = [];
      try {
        const work = await api<Work>("POST", "/api/works", { title: `문서 참조 ${format}`, cwd: null });
        const file = join(work.cwd, `참조 검사.${format}`);
        if (format === "docx") copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), file);
        else await fixture(file, format);
        const own = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
        const sourcePath = join(work.cwd, "참고자료.md"), original = '# 참고자료\n\nBASE_REFERENCE\n\n<span class="redact-span" data-redaction="" data-label="가린 값">NATIVE_REFERENCE_SECRET</span>\n';
        writeFileSync(sourcePath, original);
        const source = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: sourcePath });
        const tab = { id: "reference-target", workId: work.id, sessionId: null, view: { kind: "document", artifactId: own.id, proposalId: null }, ui: { mode: format === "html" ? "rich" : "edit" } };
        const otherTab = { id: "reference-source", workId: work.id, sessionId: null, view: { kind: "document", artifactId: source.id, proposalId: null }, ui: { mode: "rich" } };
        const panes = [{ ...tab, id: "target-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }, ...(format === "pptx" ? [{ ...otherTab, id: "source-pane", tabs: [otherTab], activeTabId: otherTab.id, recentTabIds: [otherTab.id] }] : [])];
        await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "target-pane", panes } });
        await wd.setWindowRect({ width: format === "pptx" ? 2500 : 1900, height: 1200 }); await wd.refresh(); await installProbe(wd);
        const targetFrame = await wd.waitFor('[data-pane="target-pane"] iframe.office-frame', 30000);
        await wd.frame(targetFrame); await installProbe(wd);
        if (format === "xlsx" && !await until(() => wd.execute<boolean>('return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중");'), 45000)) throw new Error("Original workbook did not finish loading");
        if (!await until(async () => { const input = await wd.find(".ai-panel textarea:not(:disabled), .copilot textarea:not(:disabled)"); return !!input && await wd.displayed(input); }, 45000)) throw new Error("Original composer did not become visible");
        const input = await wd.waitFor(".ai-panel textarea:not(:disabled), .copilot textarea:not(:disabled)", 60000);
        await wd.execute(`window.__referenceTrace = [];
          for (const name of ['slidesApi','desktop','desktopApi','htmlApi','hwpApi','mindmapApi','epubApi']) {
            const api = window[name]; if (!api?.addAttachmentPaths) continue;
            const original = api.addAttachmentPaths;
            api.addAttachmentPaths = async (...args) => { const row = {name, args}; window.__referenceTrace.push(row); try { return row.value = await original(...args); } catch (error) { row.error = String(error); throw error; } };
          }
          for (const kind of ['pointerdown','mousedown','click']) document.addEventListener(kind, e => window.__referenceTrace.push({kind,target:e.target.outerHTML?.slice(0,500)}), true);
          window.addEventListener('message', e => { if (e.data?.type === 'office:references-result') window.__referenceTrace.push({reply:e.data}); });`);
        await wd.click(input); await wd.sendKeys(input, "@참고");
        const option = await wd.waitFor(`.ai-doc-mention-row[title=${JSON.stringify(sourcePath)}]:not([aria-disabled="true"])`, 15000);
        const choice = await wd.execute<{ text: string; html: string }>('const r=arguments[0].getBoundingClientRect(); return {text: arguments[0].textContent, html: arguments[0].outerHTML, rect:r.toJSON(), hits:document.elementsFromPoint(r.x+r.width/2,r.y+r.height/2).map(el=>el.outerHTML.slice(0,350))};', option);
        writeFileSync(ctx.report.path(`references-${format}-choice.json`), JSON.stringify(choice, null, 2));
        ctx.report.check(S, "원본 @ 목록에서 프로젝트 Markdown 선택", choice.text.includes("참고자료.md"), undefined, await shot(ctx, `references-${format}-mention.png`));
        await wd.click(option);
        const attached = await until(() => wd.execute<boolean>('return document.querySelector(".ai-panel textarea, .copilot textarea")?.value.includes("@참고자료.md") === true;'));
        writeFileSync(ctx.report.path(`references-${format}-selection.json`), JSON.stringify(await wd.execute('return {input: document.querySelector(".ai-panel textarea, .copilot textarea")?.value, trace: window.__referenceTrace};'), null, 2));
        if (!attached) throw new Error("Original @ selection was not attached");
        const marker = `LATEST REFERENCE ${format.toUpperCase()}`;
        if (format === "pptx") {
          await wd.frame(null); await wd.frame(await wd.waitFor('[data-pane="source-pane"] iframe.office-frame', 30000));
          const editor = await wd.waitFor('.tiptap[contenteditable="true"]', 60000);
          await wd.click(await wd.waitFor(".tiptap h1")); await wd.sendKeys(editor, ` ${marker}`);
          ctx.report.check(S, "첨부 뒤 다른 칸의 원본 Markdown에서 미저장 편집", !readFileSync(sourcePath, "utf8").includes(marker) && await wd.execute<boolean>('return document.querySelector(".tiptap")?.textContent.includes(arguments[0]) === true;', marker));
          await wd.frame(null); await wd.frame(targetFrame);
        } else writeFileSync(sourcePath, `${original}\n${marker}\n`);
        await wd.click(input); await wd.sendKeys(input, " 이 첨부 자료를 읽고 요약해 줘");
        await wd.click(await wd.waitFor(".ai-send-btn:not(.ai-stop-btn):not(:disabled)"));
        let session: Session | undefined;
        if (!await until(async () => { session = (await snapshot()).sessions.find((item) => item.workId === work.id); return !!session; }, 20000)) throw new Error(`No first reference session: ${await wd.execute('return document.body.innerText.slice(-4000);')}`);
        if (!await until(async () => (await items(session!.id)).some((item) => item.kind === "turnEnd"), 60000)) throw new Error(`Reference run did not finish: ${await wd.execute('return document.body.innerText.slice(-4000);')}`);
        const transcript = await items(session!.id), user = transcript.find((item) => item.kind === "user");
        writeFileSync(ctx.report.path(`references-${format}-transcript.json`), JSON.stringify(transcript, null, 2));
        writeFileSync(ctx.report.path(`references-${format}-requests.json`), JSON.stringify(requests, null, 2));
        const read = transcript.filter((item) => item.kind === "tool").map((item) => item.output ?? "").join("\n");
        const complete = transcript.some((item) => item.kind === "turnEnd" && item.status === "completed");
        ctx.report.check(S, "원본 읽기 도구가 선택 이후 최신 편집을 읽고 가린 값 제외", complete && read.includes(marker) && read.includes("{{가린 값}}") && !JSON.stringify(requests).includes("NATIVE_REFERENCE_SECRET"), read.slice(-1500), await shot(ctx, `references-${format}-read.png`));
        ctx.report.check(S, "실제 참조 판·해시와 첫 요청을 같은 Workbench 세션에 기록", user?.kind === "user" && user.refs?.some((ref) => ref.artifactId === source.id && ref.revision > 1 && ref.mode === "review") === true && (await snapshot()).sessions.filter((item) => item.workId === work.id).length === 1 && readFileSync(sourcePath, "utf8").includes(marker));
        if (!complete || !read.includes(marker) || JSON.stringify(requests).includes("NATIVE_REFERENCE_SECRET")) throw new Error("Reference content did not satisfy native checks");
        const followup = `${marker} FOLLOWUP`;
        if (format === "pptx") {
          await wd.frame(null); await wd.frame(await wd.waitFor('[data-pane="source-pane"] iframe.office-frame'));
          const editor = await wd.waitFor('.tiptap[contenteditable="true"]'); await wd.click(await wd.waitFor(".tiptap h1")); await wd.sendKeys(editor, ` ${followup}`);
          await wd.frame(null); await wd.frame(targetFrame);
        } else writeFileSync(sourcePath, `${original}\n${followup}\n`);
        const again = await wd.waitFor(".ai-panel textarea:not(:disabled), .copilot textarea:not(:disabled)");
        await wd.click(again); await wd.sendKeys(again, "같은 첨부를 다시 읽어 줘"); await wd.click(await wd.waitFor(".ai-send-btn:not(.ai-stop-btn):not(:disabled)"));
        if (!await until(async () => (await items(session!.id)).filter((item) => item.kind === "turnEnd").length === 2, 45000)) throw new Error("Follow-up reference run did not finish");
        const next = await items(session!.id), lastRead = next.filter((item) => item.kind === "tool").at(-1), lastUser = next.filter((item) => item.kind === "user").at(-1);
        const firstRevision = user?.kind === "user" ? user.refs?.find((ref) => ref.artifactId === source.id)?.revision ?? 0 : 0;
        const nextRevision = lastUser?.kind === "user" ? lastUser.refs?.find((ref) => ref.artifactId === source.id)?.revision ?? 0 : 0;
        const renewed = lastRead?.kind === "tool" && lastRead.status === "completed" && lastRead.output?.includes(followup) === true && nextRevision > firstRevision;
        ctx.report.check(S, "다시 첨부하지 않아도 다음 요청에서 바뀐 최신 내용·새 판 참조", renewed, undefined, await shot(ctx, `references-${format}-followup.png`));
        writeFileSync(ctx.report.path(`references-${format}-followup-transcript.json`), JSON.stringify(next, null, 2));
        writeFileSync(ctx.report.path(`references-${format}-requests.json`), JSON.stringify(requests, null, 2));
        if (!renewed) throw new Error("Follow-up reference did not refresh");
        await wd.click(await wd.waitFor(".ai-doc-attach-btn:not(:disabled)")); await wd.frame(null);
        await wd.waitFor('.office-reference-picker[role="dialog"]');
        ctx.report.check(S, "원본 문서 첨부 버튼이 부모의 실제 선택창을 열기", await wd.execute<boolean>('return document.querySelector(".office-reference-picker")?.textContent.includes("참고자료.md") === true;'), undefined, await shot(ctx, `references-${format}-picker.png`));
        const cancel = await wd.execute<any>('return [...document.querySelectorAll(".office-reference-picker button")].find(el=>el.textContent==="취소");');
        await wd.click(cancel); await wd.frame(targetFrame);
        ctx.report.check(S, "@ 첨부·저장·읽기 중 페이지 예외 없음", (await pageErrors(wd)).length === 0);
      } catch (error) {
        ctx.report.check(S, "원본 문서 참조 진행", false, error instanceof Error ? error.message : String(error), await shot(ctx, `references-${format}-failed.png`).catch(() => null));
        try { writeFileSync(ctx.report.path(`references-${format}-diagnostic.json`), JSON.stringify(await wd.execute('return {text: document.body.innerText.slice(-7000), errors: window.__wbProbe?.errors};'), null, 2)); } catch {}
        break;
      } finally { await wd.frame(null); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}
