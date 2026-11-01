import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

const binary = resolve(process.argv[2]!), outDir = resolve(process.argv[3]!);
mkdirSync(outDir, { recursive: true });
const report = new Report(outDir), stage = await openStage(outDir, { nativeX11: true }), S = "Markdown 페이지 PNG 출력";
let ctx: Ctx | null = null, phase = "start";
try {
  ctx = { stage, app: await stage.launch({ binary, name: "markdown-images", engines: "stand-in", profile: "markdown-images" }), report }; await startScenario(ctx);
  const { wd, api } = ctx.app; await wd.setWindowRect({ width: 1600, height: 1000 });
  const work = await api<Work>("POST", "/api/works", { title: "Markdown 그림 출력", cwd: null });
  const main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const source = join(work.cwd, "원문.md"), output = join(work.cwd, "output"), marker = "LIVE UNSAVED PNG";
  mkdirSync(join(work.cwd, "assets")); mkdirSync(output); writeFileSync(join(output, "keep.txt"), "기존 파일");
  copyFileSync(resolve("vendor/ieumoffice/apps/shell/build/icons/64x64.png"), join(work.cwd, "assets/picture.png"));
  const original = "\ufeff# 그림 출력 원문\r\n\r\n![로컬 그림](assets/picture.png)\r\n\r\n" + Array.from({ length: 40 }, (_, i) => `문단 ${i + 1}. 한글 글꼴과 페이지 나눔을 확인합니다. 페이지별 그림은 원본 문서를 저장하지 않고 현재 편집 내용을 반영합니다.\r\n\r\n`).join("");
  writeFileSync(source, original);
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: source });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const tab = { id: "markdown-images-source", workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "rich" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "markdown-images-pane", panes: [{ ...tab, id: "markdown-images-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.refresh(); await installProbe(wd);
  const pane = '.pane[data-tab-active="true"]';
  const enter = async () => { await wd.frame(null); await wd.frame(await wd.waitFor(`${pane} iframe.office-frame`, 30000)); };
  const click = async (text: string, selector = "button,[role=menuitem]") => {
    if (!await until(async () => { for (const button of await wd.findAll(selector)) if (await wd.displayed(button) && await wd.execute<boolean>("return arguments[0].textContent.trim()===arguments[1]", button, text)) { await wd.click(button); return true; } return false; }, 15000)) throw new Error(`Missing command: ${text}`);
  };
  const control = (key: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyUp", value: KEY.control }]);
  const exportMenu = async () => { await wd.frame(null); await wd.click(await wd.waitFor(`${pane} button[aria-label="문서 파일 메뉴"]`)); await click("PNG 그림으로 내보내기", ".office-file-menu [role=menuitem]"); await wd.waitFor('.office-output-dialog[aria-label="PNG 그림으로 내보내기"]', 30000); };
  const destination = async () => { const field = await wd.waitFor('.office-output-dialog input[aria-label="그림을 저장할 폴더"]'); await wd.click(field); await control("a"); await wd.sendKeys(field, output); await wd.click(await wd.waitFor('.office-output-dialog button[type="submit"]')); await enter(); };
  await enter(); await installProbe(wd);
  const editor = await wd.waitFor('.tiptap[contenteditable="true"]', 60000); await wd.click(await wd.waitFor(".tiptap h1")); await control("\ue011"); await wd.sendKeys(editor, `${marker} `);
  const pictureLoaded = await until(() => wd.execute<boolean>('return document.querySelector(\'.tiptap img[alt="로컬 그림"]\')?.naturalWidth===64'), 10000);
  const imageProbe = await wd.execute('return [...document.querySelectorAll(".tiptap img")].map(x=>({src:x.src,alt:x.alt,class:x.className,width:x.naturalWidth,complete:x.complete}))');
  writeFileSync(report.path("editor-images.json"), JSON.stringify(imageProbe, null, 2));
  report.check(S, "편집기에서 실제 64px 로컬 그림을 읽음", pictureLoaded, JSON.stringify(imageProbe));
  await wd.execute(`window.__imageCalls=[];window.__failPage=false;for(const name of ["prepareImageExport","writeExportImage","finishImageExport"]){const original=window.markdownApi[name];window.markdownApi[name]=async(...args)=>{if(name==="prepareImageExport")window.__imageHtml=args[0].html;if(name==="writeExportImage"&&window.__failPage&&args[1]===2)args[2]="bm90LVBORw==";const result=await original(...args);if(result.pdfBase64)window.__imagePdf=result.pdfBase64;window.__imageCalls.push({name,page:name==="writeExportImage"?args[1]:null,success:name==="finishImageExport"?args[1]:null,result:{...result,pdfBase64:undefined}});return result}}`);
  phase = "cancel"; await exportMenu(); await click("취소", ".office-output-dialog button"); await enter();
  report.check(S, "취소는 원본과 기존 출력 폴더 보존", await until(() => wd.execute<boolean>('return window.__imageCalls.some(x=>x.result.canceled)'), 10000) && readFileSync(source, "utf8") === original && readdirSync(output).join() === "keep.txt");
  phase = "export"; await exportMenu(); await destination();
  if (!await until(() => wd.execute<boolean>('return window.__imageCalls.some(x=>x.name==="finishImageExport"&&x.result.path)'), 120000)) throw new Error("PNG export did not finish");
  const calls = await wd.execute<any[]>('return window.__imageCalls'), result = calls.find(x => x.result.path)!.result, names = readdirSync(result.path).sort();
  report.check(S, "원본 메뉴 경로에서 여러 페이지 PNG 출력", names.length >= 2 && names.every((name, i) => name === `page-${String(i + 1).padStart(2, "0")}.png`));
  const pages = names.map(name => { const bytes = readFileSync(join(result.path, name)); return { name, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), size: bytes.length, signature: bytes.subarray(0, 8).toString("hex") }; });
  report.check(S, "모든 PNG가 원본 192dpi 페이지 크기·유효 파일", pages.every(p => p.signature === "89504e470d0a1a0a" && p.width > 1300 && p.height > 1900 && p.size > 1000));
  const pdf = Buffer.from(await wd.execute<string>('return window.__imagePdf'), "base64"); writeFileSync(report.path("rendered.pdf"), pdf);
  writeFileSync(report.path("print-input.html"), await wd.execute<string>('return window.__imageHtml'));
  const text = execFileSync("pdftotext", [report.path("rendered.pdf"), "-"], { encoding: "utf8" });
  report.check(S, "그림 출력의 현재 미저장 본문과 한글 글꼴", text.includes(marker) && text.includes("그림 출력 원문") && text.includes("문단 40"));
  report.check(S, "로컬 그림도 출력에 포함", execFileSync("pdfimages", ["-list", report.path("rendered.pdf")], { encoding: "utf8" }).includes("image"));
  report.check(S, "원본 바이트·판·미저장 편집 버퍼 보존", readFileSync(source, "utf8") === original && (await snapshot()).artifacts.find(a => a.id === artifact.id)?.revision === 1 && await wd.execute<boolean>('return document.querySelector(".tiptap").textContent.includes(arguments[0])', marker));
  copyFileSync(join(result.path, names[0]!), report.path("first-page.png")); copyFileSync(join(result.path, names.at(-1)!), report.path("last-page.png"));
  writeFileSync(report.path("output.json"), JSON.stringify({ pages, calls, directory: result.path }, null, 2));
  report.check(S, "완료 안내와 기존 파일 보존", await wd.execute<boolean>('return document.body.textContent.includes("이미지")') && readFileSync(join(output, "keep.txt"), "utf8") === "기존 파일", undefined, await shot(ctx, "export-complete.png"));
  phase = "page failure cleanup"; await wd.execute('window.__imageCalls=[];window.__failPage=true'); await exportMenu(); await destination();
  if (!await until(() => wd.execute<boolean>('return window.__imageCalls.some(x=>x.name==="finishImageExport"&&x.success===false)'), 120000)) throw new Error("Failed export was not cleaned up");
  report.check(S, "2쪽 저장 실패 시 미완성 출력만 정리", readdirSync(output).length === 2 && existsSync(join(result.path, names[0]!)) && readFileSync(source, "utf8") === original);
  report.check(S, "원본 화면에 실패 표시", await wd.execute<boolean>('return document.body.textContent.includes("이미지 내보내기 실패")'));
  phase = "repeat after expected failure"; await wd.execute('window.__imageCalls=[];window.__failPage=false'); await exportMenu(); await destination();
  if (!await until(() => wd.execute<boolean>('return window.__imageCalls.some(x=>x.name==="finishImageExport"&&x.result.path)'), 120000)) throw new Error("Second PNG export did not finish");
  const next = await wd.execute<string>('return window.__imageCalls.find(x=>x.result.path).result.path');
  report.check(S, "다음 출력은 새 폴더에 저장하고 이전 결과 유지", next !== result.path && readdirSync(output).length === 3 && readdirSync(next).length === names.length && readFileSync(source, "utf8") === original);
  report.check(S, "편집기 예외 없음", (await pageErrors(wd)).length === 0); await wd.frame(null);
  report.check(S, "부모 화면 예외 없음", (await pageErrors(wd)).length === 0);
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return {text:document.body.innerText,url:location.href,calls:window.__imageCalls}').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  await stage.close(); report.write({ binary, modelCalls: 0 }); console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1;
}
