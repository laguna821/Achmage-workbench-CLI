import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import type { Engines } from "./launch.ts";
import { fixture } from "./office-suite.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8mcAAAAASUVORK5CYII=";
const COMPOSER = ".ai-panel textarea:not(:disabled), .copilot textarea:not(:disabled)";
/** Original handlers + actual parent/host/parser/storage, private synthetic model.
 * The native dialog return is injected at the Tauri dialog IPC fetch boundary; no claim of physical chooser/clipboard testing. */
export async function officeFilesScenario(ctx: Ctx, launch: { binary: string; engines: Engines; profile: string }) {
  const formats = ["pptx", "docx", "xlsx", "html", "hwpx", "xmind", "epub"] as const;
  const chosen = process.env.APP_E2E_OFFICE_FILE_FORMATS?.split(",") ?? [...formats];
  if (chosen.some((format) => !(formats as readonly string[]).includes(format))) throw new Error("Unknown attachment format");
  let requests: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
      const body = JSON.parse(raw); requests.push(body);
      res.setHeader("content-type", "text/event-stream");
      const send = (delta: unknown, finish_reason: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const fresh = JSON.stringify(body.messages.findLast((m: any) => m.role === "user")).includes("NO ATTACHMENTS");
      const reads = body.messages.filter((m: any) => m.role === "tool").length;
      if (!fresh && reads < 2) {
        if (!body.tools?.some((tool: any) => tool.function?.name === "read_attachment")) throw new Error("Original attachment tool missing");
        send({ role: "assistant", tool_calls: [{ index: 0, id: `file-${requests.length}`, type: "function", function: { name: "read_attachment", arguments: JSON.stringify({ index: reads }) } }] }, "tool_calls");
      } else send({ role: "assistant", content: fresh ? "NEW CHAT EMPTY" : "ATTACHMENTS_READ_COMPLETE" }, "stop");
      res.end("data: [DONE]\n\n");
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  const snapshot = () => ctx.app.api<Snapshot>("GET", "/api/snapshot");
  const items = async (id: string) => (await ctx.app.api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  let wd = ctx.app.wd;
  const enter = async (format: string) => {
    await wd.frame(null); await wd.frame(await wd.waitFor('[data-pane="file-pane"] iframe.office-frame', 30000)); await installProbe(wd);
    if (format === "xlsx" && !await until(() => wd.execute<boolean>('return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중");'), 45000)) throw new Error("Workbook not ready");
    if (!await until(async () => { const input = await wd.find(COMPOSER); return !!input && await wd.displayed(input); }, 45000)) throw new Error("Original composer not visible");
  };
  const send = async (text: string) => { const input = await wd.waitFor(COMPOSER); await wd.click(input); await wd.sendKeys(input, text); await wd.click(await wd.waitFor(".ai-send-btn:not(.ai-stop-btn):not(:disabled)")); };
  try {
    const settings = (await ctx.app.api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "files-fixture";
    settings.customEndpoints = [{ id: "files-fixture", name: "Local files fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "files-model", kind: "local", modelProfiles: { "files-model": { tools: true, toolsSource: "user", vision: true, visionSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    for (const format of chosen as (typeof formats)[number][]) {
      const S = `Office 첨부 ${format}`; requests = [];
      try {
        const work = await ctx.app.api<Work>("POST", "/api/works", { title: `로컬 첨부 ${format}`, cwd: null }), file = join(work.cwd, `첨부 검사.${format}`);
        if (format === "docx") copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), file); else await fixture(file, format);
        const own = await ctx.app.api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
        const csv = join(work.cwd, "선택 참고.csv"); writeFileSync(csv, "FIRST CSV VALUE,0007\n");
        const tab = { id: "file-target", workId: work.id, sessionId: null as string | null, view: { kind: "document", artifactId: own.id, proposalId: null }, ui: { mode: format === "html" ? "rich" : "edit" } };
        const layout = () => ({ version: 2, focus: "file-pane", panes: [{ ...tab, id: "file-pane", tabs: [{ ...tab }], activeTabId: tab.id, recentTabIds: [tab.id] }] });
        await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout() }); await wd.setWindowRect({ width: 1900, height: 1200 }); await wd.refresh(); await enter(format);
        await wd.execute(`const file=new File([arguments[0]],'드롭 참고.md',{type:'text/markdown'}), dt=new DataTransfer();dt.items.add(file);document.querySelector('.ai-panel,.copilot').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));`, 'LOCAL DROP VALUE\n\n<span data-redaction="" data-label="숨김">NATIVE_UPLOAD_SECRET</span>\n');
        const dropped = await until(() => wd.execute<boolean>('return document.querySelector(".ai-attachments")?.textContent.includes("드롭 참고.md")===true;'));
        ctx.report.check(S, "원본 드롭 처리기로 Markdown 바이트 첨부", dropped); if (!dropped) throw new Error("Drop did not attach");
        await wd.frame(null);
        await wd.execute(`const original=window.fetch, target=window.__TAURI_INTERNALS__.convertFileSrc("plugin:dialog|open","ipc");window.__filePickerCalls=[];window.__filePickerChoice=arguments[0];window.fetch=(url,init)=>{if(String(url)===target){window.__filePickerCalls.push({url:String(url),body:JSON.parse(init.body)});return Promise.resolve(new Response(JSON.stringify(window.__filePickerChoice),{headers:{"Content-Type":"application/json","Tauri-Response":"ok"}}));}return original(url,init);};`, [csv]);
        await enter(format); await wd.click(await wd.waitFor('.ai-attach-btn'));
        const picked = await until(() => wd.execute<boolean>('return document.querySelector(".ai-attachments")?.textContent.includes("선택 참고.csv")===true;'));
        ctx.report.check(S, "원본 파일 버튼→부모 Tauri 선택 응답→로컬 CSV 등록", picked); if (!picked) throw new Error("Picker result did not attach");
        await wd.click(await wd.waitFor(COMPOSER));
        await wd.execute(`window.__fileTrace=[];window.addEventListener('paste',e=>window.__fileTrace.push({event:'paste',files:[...e.clipboardData.files].map(f=>({name:f.name,size:f.size})),target:e.target.outerHTML.slice(0,200),active:document.activeElement===e.target}),true);
          for(const name of ['desktop','desktopApi','htmlApi','hwpApi','mindmapApi','epubApi']){const api=window[name];if(!api)continue;for(const method of ['getPathForFile','addAttachmentPaths','addPastedImage','readAttachmentImage']){if(typeof api[method]!=='function')continue;const original=api[method];api[method]=(...args)=>{const row={name,method,args:args.map(a=>a instanceof File?{name:a.name,size:a.size,type:a.type}:a instanceof ArrayBuffer?{bytes:a.byteLength}:a)};window.__fileTrace.push(row);const result=original(...args);if(result?.then)result.then(value=>row.value=value?.base64?{ok:value.ok,mime:value.mime,bytes:value.base64.length}:value,error=>row.error=String(error));else row.value=result;return result;};}}`);
        await wd.execute(`const bytes=Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0)),file=new File([bytes],'붙여넣기 그림.png',{type:'image/png'}),dt=new DataTransfer();dt.items.add(file);document.querySelector('.ai-panel textarea,.copilot textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));`, PNG);
        const pasted = await until(() => wd.execute<boolean>('const img=[...document.querySelectorAll(".ai-attachments img")].find(img=>img.alt===arguments[0]);return !!img && img.src.startsWith("data:image/png") && img.complete && img.naturalWidth > 0;', "붙여넣기 그림.png"));
        ctx.report.check(S, "원본 붙여넣기 처리기로 이미지 첨부·미리보기", pasted, undefined, await shot(ctx, `files-${format}-attached.png`)); if (!pasted) throw new Error("Paste image did not attach/render");
        await wd.frame(null); await wd.execute('window.__filePickerChoice=null;'); await enter(format); await wd.click(await wd.waitFor('.ai-attach-btn'));
        await wd.frame(null); const pickerCalls = await wd.execute<any[]>('return window.__filePickerCalls;'); await enter(format);
        ctx.report.check(S, "파일 선택 취소가 기존 첨부를 바꾸지 않음", pickerCalls.length === 2 && await wd.execute<boolean>('return document.querySelector(".ai-attachments")?.textContent.includes("선택 참고.csv")===true;'));
        await send("첨부 문서 두 개와 이미지를 확인해 줘");
        let session: Session | undefined;
        if (!await until(async () => { session = (await snapshot()).sessions.find((s) => s.workId === work.id); return !!session; }, 20000)) throw new Error("First attachment session missing");
        if (!await until(async () => (await items(session!.id)).some((i) => i.kind === "turnEnd"), 60000)) throw new Error("First attachment turn did not finish");
        const first = await items(session!.id), read = first.filter((i) => i.kind === "tool").map((i) => i.output).join("\n"), user = first.find((i) => i.kind === "user");
        const completed = first.some((i) => i.kind === "turnEnd" && i.status === "completed");
        ctx.report.check(S, "원본 도구가 파일 두 개를 읽고 가린 값은 모델 입력에서 제외", completed && read.includes("LOCAL DROP VALUE") && read.includes("FIRST CSV VALUE") && read.includes("{{숨김}}") && !JSON.stringify(requests).includes("NATIVE_UPLOAD_SECRET"), read.slice(-1800));
        ctx.report.check(S, "실제 이미지 바이트·첨부3개 메타데이터를 같은 요청에 기록", JSON.stringify(requests[0]).includes(`data:image/png;base64,${PNG}`) && user?.office?.attachments?.length === 3 && user.office.attachments.every((a) => a.fileId), undefined, await shot(ctx, `files-${format}-read.png`));
        if (!completed || !read.includes("FIRST CSV VALUE")) throw new Error("Attachment content check failed");
        writeFileSync(ctx.report.path(`files-${format}-first-transcript.json`), JSON.stringify(first, null, 2));
        writeFileSync(ctx.report.path(`files-${format}-first-requests.json`), JSON.stringify(requests, null, 2));
        const firstErrors = await pageErrors(wd); requests = []; writeFileSync(csv, "SECOND CSV VALUE,0008\n");
        tab.sessionId = session!.id; await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout() });
        if (format === chosen[0]) { await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "files-restarted" }); wd = ctx.app.wd; }
        else await wd.refresh();
        await enter(format);
        const restored = await until(() => wd.execute<boolean>('return document.body.innerText.includes("드롭 참고.md") && (document.body.innerText.includes(arguments[0]) || [...document.querySelectorAll("img")].some(img=>img.alt===arguments[0]));', "붙여넣기 그림.png"));
        ctx.report.check(S, format === chosen[0] ? "앱·호스트 재시작 후 같은 대화의 첨부 표시 복원" : "문서 재열기 후 같은 대화의 첨부 표시 복원", restored); if (!restored) throw new Error("Attachment history missing");
        await send("첨부를 다시 올리지 않고 같은 자료를 읽어 줘");
        if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length === 2, 60000)) throw new Error("Reopened attachment turn did not finish");
        const second = await items(session!.id), last = second.filter((i) => i.kind === "tool").at(-1), again = second.filter((i) => i.kind === "user").at(-1);
        ctx.report.check(S, "재첨부 없이 최신 로컬 CSV·보관 Markdown·이미지를 다시 읽음", last?.kind === "tool" && last.output?.includes("SECOND CSV VALUE") === true && JSON.stringify(requests[0]).includes(`data:image/png;base64,${PNG}`) && again?.office?.attachments?.length === 3, undefined, await shot(ctx, `files-${format}-restored.png`));
        writeFileSync(ctx.report.path(`files-${format}-restored-transcript.json`), JSON.stringify(second, null, 2));
        writeFileSync(ctx.report.path(`files-${format}-restored-requests.json`), JSON.stringify(requests, null, 2));
        requests = []; const before = new Set((await snapshot()).sessions.map((s) => s.id));
        await wd.click(await wd.waitFor('.ai-header-btn[aria-label*="새 대화"]'));
        let next: Session | undefined;
        if (!await until(async () => { next = (await snapshot()).sessions.find((s) => !before.has(s.id) && s.workId === work.id); return !!next; }, 20000)) throw new Error("New conversation missing");
        if (!await until(() => wd.execute<boolean>('return window.workbenchOfficeAi.snapshot()===arguments[0];', next!.id))) throw new Error("New conversation not selected");
        await send("NO ATTACHMENTS 새 대화 확인");
        if (!await until(async () => (await items(next!.id)).some((i) => i.kind === "turnEnd"), 45000)) throw new Error("Empty new conversation did not finish");
        const fresh = await items(next!.id), freshUser = fresh.find((i) => i.kind === "user"), sent = JSON.stringify(requests);
        ctx.report.check(S, "새 대화에는 이전 첨부·이미지·읽기 권한을 넘기지 않음", !freshUser?.office?.attachments?.length && !sent.includes("드롭 참고.md") && !sent.includes("data:image/png;base64,") && fresh.some((i) => i.kind === "turnEnd" && i.status === "completed"));
        ctx.report.check(S, "첨부·재열기·새 대화 중 페이지 예외 없음", firstErrors.length === 0 && (await pageErrors(wd)).length === 0, JSON.stringify([...firstErrors, ...await pageErrors(wd)]));
      } catch (error) {
        ctx.report.check(S, "로컬 첨부 진행", false, String(error), await shot(ctx, `files-${format}-failed.png`).catch(() => null));
        writeFileSync(ctx.report.path(`files-${format}-diagnostic.json`), JSON.stringify({ error: String(error), page: await wd.execute('return document.body.innerText.slice(-10000);').catch(() => null), errors: await pageErrors(wd).catch(() => []), trace: await wd.execute("return window.__fileTrace;").catch(() => null), requests }, null, 2));
        break;
      } finally { await wd.frame(null); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}
