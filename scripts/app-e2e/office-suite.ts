import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import initHwp, { HwpDocument } from "../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js";
import { hwpToText } from "../../third_party/ieumoffice/file-parse/hwp.ts";
import { mindmapFixture } from "./mindmap-fixture.ts";
import { epubFixture } from "./epub-fixture.ts";
import { officeUndo } from "./office-undo.ts";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
const require = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument, PDFName } = require("pdf-lib");
type Format = "md" | "html" | "xmind" | "epub" | "hwpx" | "pdf" | "pptx" | "xlsx";
const formats: Format[] = ["md", "html", "xmind", "epub", "hwpx", "pdf", "pptx", "xlsx"];
const marker = (format: Format) => `WORKBENCH ${format.toUpperCase()} NATIVE AI EDIT`;
async function xlsxFixture() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Native Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Original text.</t></is></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData></worksheet>');
  return zip.generateAsync({ type: "nodebuffer" });
}
export async function fixture(file: string, format: Format) {
  if (format === "md") writeFileSync(file, "# Native document\n\nOriginal text.\n");
  else if (format === "html") writeFileSync(file, '<!DOCTYPE html><html><head><title>Native document</title></head><body><h1>Native document</h1><p>Original text.</p></body></html>');
  else if (format === "xmind") writeFileSync(file, await mindmapFixture());
  else if (format === "epub") writeFileSync(file, await epubFixture());
  else if (format === "pptx") copyFileSync(resolve("vendor/ieumoffice/packages/pptx-engine/tests/fixtures/01_standard_business.pptx"), file);
  else if (format === "xlsx") writeFileSync(file, await xlsxFixture());
  else if (format === "hwpx") {
    await initHwp({ module_or_path: readFileSync(resolve("vendor/ieumoffice/vendor/rhwp-core/rhwp_bg.wasm")) });
    const doc = HwpDocument.createEmpty(); doc.createBlankDocument(); doc.insertText(0, 0, 0, "Original text."); writeFileSync(file, doc.exportHwpx()); doc.free();
  } else {
    const doc = await PDFDocument.create(); doc.addPage([400, 600]).drawText("Original text.", { x: 30, y: 550, size: 18 }); writeFileSync(file, await doc.save({ useObjectStreams: false }));
  }
}
async function savedText(file: string, format: Format): Promise<string> {
  const bytes = readFileSync(file);
  if (format === "md" || format === "html") return bytes.toString();
  if (format === "hwpx") return hwpToText(bytes);
  if (format === "pdf") {
    const doc = await PDFDocument.load(bytes);
    return doc.getPages().flatMap((page: any) => {
      const annots = page.node.Annots();
      return annots ? annots.asArray().map((ref: any) => doc.context.lookup(ref).get(PDFName.of("Contents"))?.decodeText?.() ?? "") : [];
    }).join("\n");
  }
  const zip = await JSZip.loadAsync(bytes);
  return (await Promise.all(Object.keys(zip.files).filter((name) => /\.(xml|xhtml|json)$/.test(name)).map((name) => zip.file(name)!.async("string")))).join("\n");
}
function toolCall(format: Format, count: number, body: any): { name: string; input: object } | null {
  const text = marker(format);
  if (format === "epub") {
    if (count === 1) return { name: "read_chapter", input: { chapter: 1 } };
    if (count === 2) {
      const raw = body.messages.filter((item: any) => item.role === "tool").at(-1)?.content;
      const page = JSON.parse(raw), block = page.blocks.find((item: any) => item.text === "First paragraph.");
      if (!block) throw new Error(`EPUB fixture block missing: ${raw}`);
      return { name: "edit_blocks", input: { ops: [{ op: "replace", chapter: 1, blockId: block.id, text }] } };
    }
    return null;
  }
  if (format === "xlsx") {
    if (count === 1) return { name: "get_workbook_context", input: {} };
    if (count === 2) {
      const raw = body.messages.filter((item: any) => item.role === "tool").at(-1)?.content;
      const sheetId = /Active sheet: .*?\(id=([^,)]+)/.exec(raw)?.[1];
      if (!sheetId) throw new Error(`XLSX fixture sheet missing: ${raw}`);
      return { name: "propose_operations", input: { operations: [{ op: "set_cell", sheetId, address: "A1", value: text, expectedValue: "Original text." }], summary: "Native fixture cell edit" } };
    }
    return null;
  }
  if (count !== 1) return null;
  switch (format) {
    case "md": return { name: "apply_ops", input: { ops: [{ op: "insertContent", after: -1, markdown: text }] } };
    case "html": return { name: "apply_ops", input: { ops: [{ op: "str_replace", old: "Original text.", new: text }] } };
    case "xmind": return { name: "edit_map", input: { edits: [{ op: "set_title", id: "root-1", title: text }] } };
    case "hwpx": return { name: "replace_all", input: { find: "Original text.", replace: text } };
    case "pdf": return { name: "add_note", input: { page: 1, text, x: 50, y: 100 } };
    case "pptx": return { name: "apply_ops", input: { ops: [{ op: "setNotes", target: { slide: 0 }, text }] } };
  }
}

/** Actual original panels/tools in Linux Tauri; only the remote model is synthetic. */
export async function officeSuiteScenario(ctx: Ctx) {
  const { wd, api } = ctx.app;
  const unbound = process.env.APP_E2E_OFFICE_UNBOUND === "1";
  const selected = process.env.APP_E2E_OFFICE_FORMATS?.split(",") ?? formats;
  if (selected.some((format) => !formats.includes(format as Format))) throw new Error("Unknown Office suite format");
  let active: Format = "md", count = 0, cancelled = 0, phase = "setup";
  let requests: any[] = [], fixtureWrites: unknown[] = [];
  let currentSession = "";
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
      const body = JSON.parse(raw); requests.push(body); count++;
      res.setHeader("content-type", "text/event-stream");
      const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "suite-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (raw.includes("__suite_cancel__")) {
        fixtureWrites.push({at:Date.now(),format:active,count,headersSent:res.headersSent});
        send({ role: "assistant", content: "중지 전 부분 답변" });
        const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 30000);
        res.once("close", () => { clearTimeout(timer); if (!res.writableEnded) cancelled++; }); return;
      }
      const undoRead = active === "pdf" && String(body.messages.findLast((item: any) => item.role === "user")?.content).includes("__suite_undo_read__");
      const tool = undoRead ? (body.messages.at(-1)?.role === "tool" ? null : { name: "read_annotations", input: { start: 1, end: 1 } }) : raw.includes("__suite_fresh__") ? null : toolCall(active, count, body);
      if (tool) {
        if (!body.tools?.some((item: any) => item.function?.name === tool.name)) throw new Error(`Original tool ${tool.name} missing for ${active}`);
        send({ role: "assistant", tool_calls: [{ index: 0, id: `suite-${active}-${count}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] }); send({}, "tool_calls");
      } else { send({ role: "assistant", content: undoRead ? "UNDO_READ_COMPLETE" : "Workbench 같은 세션에 수정 완료" }); send({}, "stop"); }
      res.end("data: [DONE]\n\n");
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
  settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "suite-fixture";
  settings.customEndpoints = [{ id: "suite-fixture", name: "Local suite fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "suite-model", kind: "local", modelProfiles: { "suite-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
  mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  const send = async (text: string) => {
    const selector = ".ai-panel textarea:not(:disabled), .copilot textarea:not(:disabled)";
    if (!await until(async () => { const input = await wd.find(selector); return !!input && await wd.displayed(input); }, 45000)) throw new Error("Original composer did not become ready");
    const input = await wd.waitFor(selector);
    if (unbound) await wd.execute('window.__firstOfficeComposer ??= arguments[0];', input);
    phase = "click composer"; await wd.click(input);
    phase = "type prompt"; await wd.sendKeys(input, text);
    phase = "verify prompt";
    const typed = await wd.execute<string>('return arguments[0].value;', input);
    if (typed !== text) throw new Error(`Composer lost text: expected ${JSON.stringify(text)}, received ${JSON.stringify(typed)}`);
    phase = "send prompt"; await wd.click(await wd.waitFor(".ai-send-btn:not(.ai-stop-btn):not(:disabled)"));
  };
  try {
    for (const format of selected as Format[]) {
      const S = `Office AI ${format}`; phase = "open editor"; active = format; count = 0; requests = []; fixtureWrites = []; cancelled = 0;
      try {
        const work = await api<Work>("POST", "/api/works", { title: `Native AI ${format}`, cwd: null });
        let session = unbound ? undefined : await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
        currentSession = session?.id ?? "";
        const file = join(work.cwd, `Native AI.${format}`); await fixture(file, format);
        const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
        const tab = { id: "suite-tab", workId: work.id, sessionId: session?.id ?? null, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: format === "md" || format === "html" ? "rich" : "edit" } };
        await wd.frame(null);
        await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "suite-pane", panes: [{ ...tab, id: "suite-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
        await wd.setWindowRect({ width: 1900, height: 1200 }); await wd.refresh(); await installProbe(wd);
        await wd.frame(await wd.waitFor("iframe.office-frame", 30000)); await installProbe(wd);
        if (format === "xlsx" && !await until(() => wd.execute<boolean>('return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중");'), 45000)) throw new Error("Original workbook did not finish loading");
        if (format === "xlsx") await wd.execute('window.__suiteFocus=[];const f=HTMLElement.prototype.focus;HTMLElement.prototype.focus=function(...args){window.__suiteFocus.push({kind:"call",from:document.activeElement?.outerHTML.slice(0,250),to:this.outerHTML.slice(0,250),stack:new Error().stack});return f.apply(this,args)};document.addEventListener("keydown",e=>window.__suiteFocus.push({kind:"key",key:e.key,target:e.target.outerHTML.slice(0,250)}),true);document.addEventListener("focusin",e=>window.__suiteFocus.push({kind:"focus",target:e.target.outerHTML.slice(0,250)}),true);');
        if (format === "pdf") await wd.execute('window.__suitePdfSaves=[];const api=window.pdfApi,save=api.save;api.save=async(...args)=>{const entry={args};window.__suitePdfSaves.push(entry);try{return entry.result=await save(...args)}catch(error){entry.error=String(error);throw error}};');
        if (unbound) ctx.report.check(S, "세션 없이 문서를 열어도 불필요한 대화를 만들지 않음", (await snapshot()).sessions.every((item) => item.workId !== work.id));
        await send(`원본 도구로 이 문서를 수정해 줘. __suite_${format}__`);
        if (unbound) {
          if (!await until(async () => (await snapshot()).sessions.some((item) => item.workId === work.id), 15000)) throw new Error(`First Office session was not created: ${await wd.execute('return document.body.innerText.slice(-3500)')}`);
          session = (await snapshot()).sessions.find((item) => item.workId === work.id);
        }
        if (!session) throw new Error("No Office conversation session");
        currentSession = session.id;
        if (!await until(async () => (await items(session.id)).some((item) => item.kind === "turnEnd"), 60000)) throw new Error(`Run did not finish: ${await wd.execute('return document.body.innerText.slice(-3500)')}`);
        let transcript = await items(session.id);
        if (format === "pdf") writeFileSync(ctx.report.path("suite-pdf-saves.json"), JSON.stringify(await wd.execute('return window.__suitePdfSaves'), null, 2));
        writeFileSync(ctx.report.path(`suite-${format}-transcript.json`), JSON.stringify(transcript, null, 2));
        const completed = transcript.some((item) => item.kind === "turnEnd" && item.status === "completed");
        if (unbound) ctx.report.check(S, "첫 요청이 만든 한 세션에 정확히 한 번 기록·원본 입력창 유지", completed && (await snapshot()).sessions.filter((item) => item.workId === work.id).length === 1 && transcript.filter((item) => item.kind === "user" && item.text === `원본 도구로 이 문서를 수정해 줘. __suite_${format}__`).length === 1 && await wd.execute<boolean>('return window.__firstOfficeComposer === document.querySelector(".ai-panel textarea, .copilot textarea");'));
        const saved = (await savedText(file, format)).includes(marker(format));
        ctx.report.check(S, "원본 도구로 실제 파일 수정·저장", completed && saved && (await snapshot()).artifacts.find((item) => item.id === artifact.id)!.revision > 1, JSON.stringify(transcript.filter((item) => item.kind === "tool")).slice(-1000), await shot(ctx, `suite-${format}-edit.png`));
        if (!completed || !saved) throw new Error("Original tool did not save the expected content");
        ctx.report.check(S, "선택한 Workbench 세션에 요청·도구·응답·완료 함께 기록", transcript.some((item) => item.kind === "user" && item.office?.artifactId === artifact.id) && transcript.some((item) => item.kind === "tool" && item.status === "completed") && transcript.some((item) => item.kind === "assistant" && item.text.includes("수정 완료")));
        if (format === "xlsx") {
          const focus = await wd.execute<any[]>('return window.__suiteFocus||[]');
          writeFileSync(ctx.report.path("suite-xlsx-initial-focus.json"), JSON.stringify(focus, null, 2));
          if (!focus.some((event) => event.kind === "key")) throw new Error("No initial input focus observation");
          if (focus.some((event) => event.kind === "call" && event.from?.startsWith("<textarea") && event.to?.startsWith("<div contenteditable"))) throw new Error("Univer took focus from the original AI composer");
        }
        if (process.env.APP_E2E_OFFICE_UNDO === "1") await officeUndo(ctx, format, artifact.id, marker(format), () => savedText(file, format), format === "pdf" ? async () => {
          const before = (await items(session.id)).length;
          await send("__suite_undo_read__ 되돌린 문서의 주석을 읽어 줘.");
          const done = await until(async () => (await items(session.id)).slice(before).some((item) => item.kind === "turnEnd" && item.status === "completed"), 30000);
          const fresh = (await items(session.id)).slice(before);
          const read = fresh.find((item) => item.kind === "tool" && item.detail?.startsWith("read_annotations"));
          const output = read?.kind === "tool" ? read.output ?? "" : "";
          const ok = done && read?.kind === "tool" && read.status === "completed" && output === "No notes or markups on pages 1-1.";
          writeFileSync(ctx.report.path("suite-pdf-undone-read.json"), JSON.stringify(fresh, null, 2));
          ctx.report.check(S, "되돌린 판을 다음 AI 원본 주석 읽기 도구에 반영", ok, output);
          if (!ok) throw new Error("PDF AI read did not observe the undone document");
          transcript = await items(session.id);
        } : undefined);
        const firstErrors = await pageErrors(wd);
        await wd.frame(null); await wd.refresh(); await installProbe(wd); await wd.frame(await wd.waitFor("iframe.office-frame", 30000)); await installProbe(wd);
        ctx.report.check(S, "다시 열면 같은 세션의 대화 복원", await until(() => wd.execute<boolean>('return [...document.querySelectorAll(".ai-panel,.copilot")].some(el=>el.textContent.includes("수정 완료"));'), 30000));
        await wd.execute('document.querySelector("#root").firstElementChild.dataset.suiteKept="yes";window.__suiteChunks=[];window.workbenchOfficeAi.desktop.onAiStream(c=>window.__suiteChunks.push({at:Date.now(),...c}));window.__suiteNetwork=[];const fetch=window.fetch;window.fetch=async(...args)=>{const res=await fetch(...args);if(String(args[0]).includes("/ai/stream")&&res.body){const get=res.body.getReader.bind(res.body);res.body.getReader=(...params)=>{const reader=get(...params),read=reader.read.bind(reader),decoder=new TextDecoder();reader.read=async()=>{const next=await read();window.__suiteNetwork.push({at:Date.now(),done:next.done,text:decoder.decode(next.value,{stream:!next.done})});return next};return reader}}return res};');
        await wd.click(await wd.waitFor('.ai-header-btn[aria-label*="새 대화"]', 15000));
        if (!await until(async () => (await snapshot()).sessions.filter((item) => item.workId === work.id).length === 2, 15000)) throw new Error("Workbench new session was not created");
        const next = (await snapshot()).sessions.find((item) => item.workId === work.id && item.id !== session.id)!;
        currentSession = next.id;
        ctx.report.check(S, "새 대화는 Workbench 세션을 만들고 편집 화면 유지", await until(() => wd.execute<boolean>('return window.workbenchOfficeAi.snapshot()===arguments[0] && document.querySelector("#root").firstElementChild.dataset.suiteKept==="yes";', next.id)));
        await send("__suite_fresh__ 새 세션 확인");
        ctx.report.check(S, "다음 요청이 새 세션에만 기록", await until(async () => (await items(next.id)).some((item) => item.kind === "turnEnd" && item.status === "completed"), 30000) && (await items(session.id)).length === transcript.length);
        if (process.env.APP_E2E_OFFICE_STREAM_STRESS === "1") await wd.execute('let blocked=false;window.workbenchOfficeAi.desktop.onAiStream(c=>{if(c.type!=="ping"||blocked)return;blocked=true;const start=performance.now();while(performance.now()-start<200){};window.__suiteReaderBlock=performance.now()-start;});');
        await send("__suite_cancel__ 중지 검사");
        if (!await until(async () => (await items(next.id)).some((item) => item.kind === "assistant" && item.text.includes("부분 답변")), 15000)) throw new Error("No partial response");
        await wd.click(await wd.waitFor(".ai-stop-btn"));
        ctx.report.check(S, "실제 스트림 중지·같은 세션에 부분 답변 보존", await until(async () => cancelled === 1 && (await items(next.id)).some((item) => item.kind === "turnEnd" && item.status === "interrupted"), 15000));
        ctx.report.check(S, "페이지 예외 없음", firstErrors.length === 0 && (await pageErrors(wd)).length === 0, JSON.stringify([...firstErrors, ...await pageErrors(wd)]));
        writeFileSync(ctx.report.path(`suite-${format}-next-transcript.json`), JSON.stringify(await items(next.id), null, 2));
      } catch (error) {
        writeFileSync(ctx.report.path(`suite-${format}-failure.json`), JSON.stringify({ error: String(error), phase, composer: await wd.execute('return [...document.querySelectorAll(".copilot textarea,.ai-panel textarea")].map(el=>({html:el.outerHTML,rect:el.getBoundingClientRect().toJSON(),active:document.activeElement===el,disabled:el.disabled,inert:!!el.closest("[inert]")}));').catch(() => []), page: await wd.execute('return document.body.innerText').catch(() => null), errors: await pageErrors(wd).catch(() => []) }, null, 2));
        ctx.report.check(S, "전체 편집기 시나리오 완료", false, String(error), await shot(ctx, `suite-${format}-failure.png`).catch(() => null));
      } finally {
        writeFileSync(ctx.report.path(`suite-${format}-requests.json`), JSON.stringify(requests, null, 2));
        writeFileSync(ctx.report.path(`suite-${format}-stream-debug.json`), JSON.stringify({readerBlockMs:await wd.execute('return window.__suiteReaderBlock||0').catch(()=>0),focus:await wd.execute('return window.__suiteFocus||[]').catch(()=>[]),network:await wd.execute('return window.__suiteNetwork||[]').catch(()=>[]),fixtureWrites,chunks:await wd.execute('return window.__suiteChunks||[]').catch(()=>[]),items:currentSession ? await items(currentSession) : []},null,2));
      }
    }
  } finally { await wd.frame(null).catch(() => {}); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}
