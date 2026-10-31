import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";

/** Real system WebView output, checked with a PDF parser and rendered for review. */
export async function officeOutputScenario(ctx: Ctx) {
  const { wd } = ctx.app, S = "공통 HTML 출력";
  await wd.frame(null);
  const font = readFileSync(join(import.meta.dirname, "../../apps/web/public/fonts/sametone/fonts/AchmageSameTone[wght].woff2")).toString("base64");
  const image = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#008b80"/></svg>').toString("base64")}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>@font-face{font-family:Output;src:url(data:font/woff2;base64,${font})}body{font-family:Output,sans-serif;font-size:18px;color:#123456}.page+.page{break-before:page}img{width:120px;height:80px}</style></head><body><section class="page"><h1>시스템 문서 출력</h1><p>NATIVE HTML PAGE ONE</p><img src="${image}"><p><a href="https://example.com/output">출력 링크</a></p></section><section class="page"><h1>두 번째 페이지</h1><p>NATIVE HTML PAGE TWO</p></section><script>document.body.textContent='SCRIPT EXECUTED';</script></body></html>`;
  await wd.execute(`window.__htmlOutputTest={state:"running"};window.__TAURI_INTERNALS__.invoke("render_html_pdf",{job:arguments[0]}).then(bytes=>{
    const array=new Uint8Array(bytes);let binary="";for(let i=0;i<array.length;i+=32768)binary+=String.fromCharCode(...array.subarray(i,i+32768));
    window.__htmlOutputTest={state:"done",base64:btoa(binary)};
  },error=>{window.__htmlOutputTest={state:"failed",error:String(error)}});`,
  { html, widthIn: 210 / 25.4, heightIn: 297 / 25.4, margins: { top: 0.6, right: 0.6, bottom: 0.6, left: 0.6 }, scale: 1 });
  if (!await until(() => wd.execute<boolean>('return window.__htmlOutputTest.state !== "running"'), 135000)) throw new Error("Native HTML output did not settle");
  const result = await wd.execute<{ state: string; base64?: string; error?: string }>('return window.__htmlOutputTest');
  if (result.state !== "done" || !result.base64) throw new Error(`Native HTML output: ${result.error}`);
  const path = ctx.report.path("native-html.pdf"); writeFileSync(path, Buffer.from(result.base64, "base64"));
  const info = execFileSync("pdfinfo", [path], { encoding: "utf8" });
  const text = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
  writeFileSync(ctx.report.path("native-html-info.txt"), info); writeFileSync(ctx.report.path("native-html-text.txt"), text);
  execFileSync("pdftoppm", ["-f", "1", "-singlefile", "-scale-to", "1200", "-png", path, ctx.report.path("native-html-page")]);
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);
  const a4 = !!size && Math.abs(Number(size[1]) - 210 / 25.4 * 72) < 0.5 && Math.abs(Number(size[2]) - 297 / 25.4 * 72) < 0.5;
  ctx.report.check(S, "시스템 WebView PDF · A4 두 쪽", /Pages:\s+2\b/.test(info) && a4, info.match(/Pages:.*|Page size:.*/g)?.join("; "));
  ctx.report.check(S, "한글과 두 쪽의 텍스트 보존", ["시스템 문서 출력", "두 번째 페이지", "NATIVE HTML PAGE ONE", "NATIVE HTML PAGE TWO"].every(value => text.includes(value)), text.slice(0, 200));
  ctx.report.check(S, "문서 스크립트 실행 차단", !text.includes("SCRIPT EXECUTED"));
  ctx.report.note(S, "그림·글꼴·링크와 시각 검토용 PDF/PNG", { path, page: ctx.report.path("native-html-page.png") });

  await wd.execute(`window.__htmlPrintTest={state:"running"};window.__TAURI_INTERNALS__.invoke("print_html",{job:arguments[0]}).then(()=>{
    window.__htmlPrintTest={state:"done"};
  },error=>{window.__htmlPrintTest={state:"failed",error:String(error)}});`,
  { html, widthIn: 210 / 25.4, heightIn: 297 / 25.4, margins: { top: 0.6, right: 0.6, bottom: 0.6, left: 0.6 }, scale: 1 });
  const printSettled = await until(() => wd.execute<boolean>('return window.__htmlPrintTest.state !== "running"'), 35000);
  const printResult = await wd.execute<{ state: string; error?: string }>('return window.__htmlPrintTest');
  const dialogPath = ctx.report.path("native-print-dialog.txt");
  const dialog = existsSync(dialogPath) ? readFileSync(dialogPath, "utf8") : "";
  ctx.report.check(S, "시스템 인쇄 대화상자 열기·취소·정상 반환", printSettled && printResult.state === "done" && dialog.includes("type=GtkPrintUnixDialog") && dialog.includes("response=cancel"), `${JSON.stringify(printResult)}\n${dialog}`, ctx.report.path("native-print-dialog.png"));
  if (!printSettled || printResult.state !== "done") throw new Error(`Native HTML print: ${printResult.error ?? printResult.state}`);

  const { api } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "원본 문서 PDF 출력", cwd: null });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const key = (value: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value }, { type: "keyUp", value }, { type: "keyUp", value: KEY.control }]);
  const click = async (text: string, selector = "button,[role=menuitem]") => {
    if (!await until(async () => {
      for (const button of await wd.findAll(selector)) if (await wd.displayed(button) && await wd.execute<boolean>('return arguments[0].textContent.trim() === arguments[1]', button, text)) { await wd.click(button); return true; }
      return false;
    }, 15000)) throw new Error(`Missing command: ${text}`);
  };
  const selected = process.env.APP_E2E_OUTPUT_FORMATS?.split(",").map(value => value.trim()).filter(Boolean) ?? ["md", "html", "pptx", "docx"];
  for (const format of selected) {
    const source = join(work.cwd, `Output.${format}`), marker = `UNSAVED OUTPUT ${format.toUpperCase()}`;
    let artifact: Artifact;
    if (format === "docx") artifact = await api<Artifact>("POST", `/api/works/${work.id}/office-documents`, { format: "docx", name: "Output.docx", sessionId: session.id });
    else {
      mkdirSync(join(work.cwd, "assets"), { recursive: true });
      writeFileSync(join(work.cwd, "assets/picture.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#008b80"/></svg>');
      writeFileSync(join(work.cwd, "assets/print.css"), 'h1{color:#006b70}img{width:120px;height:80px}');
      if (format === "md") writeFileSync(source, '# Original Markdown\n\n![원본 그림](assets/picture.svg)\n\nOriginal text.\n');
      else if (format === "html") writeFileSync(source, '<!doctype html><html><head><base href="assets/"><link rel="stylesheet" href="print.css"></head><body><h1>Original HTML</h1><img src="picture.svg"><p>Original text.</p></body></html>');
      else if (format === "pptx") copyFileSync(join(import.meta.dirname, "../../vendor/ieumoffice/packages/pptx-engine/tests/fixtures/01_standard_business.pptx"), source);
      else throw new Error(`Unknown output format ${format}`);
      artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: source });
    }
    const original = readFileSync(artifact.path);
    const tab = { id: "output-tab", workId: work.id, sessionId: session.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: format === "md" || format === "html" ? "rich" : "edit" } };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "output-pane", panes: [{ ...tab, id: "output-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
    const enter = async () => { await wd.frame(null); await wd.frame(await wd.waitFor("iframe.office-frame", 30000)); };
    await enter(); await installProbe(wd);
    if (format === "html") await click("분할");
    if (format !== "pptx") {
      const editor = await wd.waitFor(format === "html" ? '.cm-content[contenteditable="true"]' : '.tiptap[contenteditable="true"]', 60000);
      await wd.click(editor); await wd.sendKeys(editor, format === "html" ? `<p>${marker}</p>` : marker);
    } else {
      if (!await until(() => wd.execute<boolean>('return !!window.Konva?.stages?.some(stage=>stage.find("Text").some(node=>node.text().trim().length>4));'), 60000)) throw new Error("Slides did not load");
      const point = await wd.execute<{ x: number; y: number }>('const stage=window.Konva.stages.reduce((a,b)=>a.width()>b.width()?a:b);const node=stage.find("Text").find(n=>n.text().trim().length>4),r=node.getClientRect(),b=stage.container().getBoundingClientRect(),s=b.width/stage.width();return {x:b.left+(r.x+r.width/2)*s,y:b.top+(r.y+r.height/2)*s};');
      await wd.frame(null); const frame = await wd.waitFor("iframe.office-frame"), box = await wd.rect(frame);
      await wd.pointer([{ type: "pointerMove", x: Math.round(box.x + point.x), y: Math.round(box.y + point.y), origin: "viewport" }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 80 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
      await wd.frame(frame); await wd.sendKeys(await wd.waitFor('.slide-text-editor[contenteditable="true"]'), marker); await wd.press(KEY.escape);
    }
    await wd.execute(`window.__outputCapture={};window.__outputMessages=[];addEventListener('message',event=>{if(String(event.data?.type).startsWith('office:'))window.__outputMessages.push(event.data.type)});
      const api=window.markdownApi||window.htmlApi||window.slidesApi||window.desktop, original=api?.exportPdf;
      if(original)api.exportPdf=function(...args){window.__outputCapture={called:true,htmlLength:args[0]?.html?.length,args:args.map(v=>typeof v==='number'||typeof v==='string'?v:typeof v)};return original.apply(this,args).then(result=>{window.__outputCapture.result=result;return result},error=>{window.__outputCapture.error=String(error);throw error})};`);
    await wd.frame(null);
    await wd.execute(`window.__renderMeta=[];addEventListener('message',event=>{const data=event.data;if(data?.type==='office:output'&&data.job?.html)window.__renderMeta.push({action:data.action,htmlLength:data.job.html.length,width:data.job.widthIn,height:data.job.heightIn,scale:data.job.scale,margins:data.job.margins})});`);
    await wd.click(await wd.waitFor('.doc-header-right .office-file-menu button[aria-label="문서 파일 메뉴"]'));
    await click("PDF로 내보내기", '.office-file-menu [role="menuitem"]');
    let exportError: string | null = null;
    if (!await until(async () => {
      await wd.frame(null); if (await wd.find(".office-output-dialog")) return true;
      await enter(); const diagnostic = await wd.execute<{ result?: { ok?: boolean }; error?: string }>('return window.__outputCapture');
      if (diagnostic.error || diagnostic.result?.ok === false) {
        writeFileSync(ctx.report.path(`output-${format}-diagnostic.json`), JSON.stringify(await wd.execute('return {capture:window.__outputCapture,messages:window.__outputMessages,errors:window.__e2e?.errors}'), null, 2));
        await wd.frame(null); writeFileSync(ctx.report.path(`output-${format}-render-meta.json`), JSON.stringify(await wd.execute('return window.__renderMeta'), null, 2));
        exportError = `${format}: original export: ${JSON.stringify(diagnostic)}`; return true;
      }
      return false;
    }, 90000)) {
      await enter(); writeFileSync(ctx.report.path(`output-${format}-failure.txt`), await wd.execute<string>('return document.body.innerText'));
      writeFileSync(ctx.report.path(`output-${format}-diagnostic.json`), JSON.stringify(await wd.execute('return {capture:window.__outputCapture,messages:window.__outputMessages,errors:window.__e2e?.errors}'), null, 2));
      throw new Error(`${format}: original export did not reach destination selection`);
    }
    if (exportError) throw new Error(exportError);
    const target = join(work.cwd, `Exported-${format}.pdf`), field = await wd.waitFor('.office-output-dialog input[aria-label="저장할 파일 경로"]');
    await wd.click(field); await key("a"); await wd.sendKeys(field, target); await wd.click(await wd.waitFor('.office-output-dialog button[type="submit"]'));
    if (!await until(async () => existsSync(target) && (await snapshot()).artifacts.some(a => a.path === target), 120000)) {
      await enter(); writeFileSync(ctx.report.path(`output-${format}-failure.txt`), await wd.execute<string>('return document.body.innerText'));
      throw new Error(`${format}: original export did not create the PDF`);
    }
    const pdfText = execFileSync("pdftotext", ["-layout", target, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
    const pdfInfo = execFileSync("pdfinfo", [target], { encoding: "utf8" });
    copyFileSync(target, ctx.report.path(`exported-${format}.pdf`)); writeFileSync(ctx.report.path(`exported-${format}-text.txt`), pdfText);
    ctx.report.check(S, `${format}: 공통 메뉴 → 원본 출력 → 미저장 편집 내용 PDF`, pdfText.includes(marker), pdfText.slice(0, 250), await shot(ctx, `output-${format}.png`));
    ctx.report.check(S, `${format}: 원본 파일·판 보존`, readFileSync(artifact.path).equals(original) && (await snapshot()).artifacts.find(a => a.id === artifact.id)?.revision === artifact.revision);
    ctx.report.note(S, `${format}: 출력 용지·쪽수`, pdfInfo.match(/Pages:.*|Page size:.*/g));
    await enter(); const errors = await pageErrors(wd); ctx.report.note(S, `${format}: 편집기 관측 오류`, errors); await wd.frame(null);
  }
}
