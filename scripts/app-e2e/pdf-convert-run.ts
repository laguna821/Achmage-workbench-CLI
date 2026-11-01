import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";
const { PDFDocument } = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url))("pdf-lib");
const { PNG } = createRequire(import.meta.url)("pngjs");
const binary = resolve(process.argv[2]!), outDir = resolve(process.argv[3]!); mkdirSync(outDir, { recursive: true });
const report = new Report(outDir), S = "PDF 변환·그림 출력", stage = await openStage(outDir, { nativeX11: true });
let ctx: Ctx | null = null, phase = "start";
try {
  ctx = { stage, app: await stage.launch({ binary, engines: "stand-in", name: "pdf-convert" }), report }; await startScenario(ctx);
  const { wd, api } = ctx.app, snapshot = () => api<Snapshot>("GET", "/api/snapshot"), pane = '.pane[data-tab-active="true"]:not([hidden])';
  await wd.setWindowRect({ width: 1700, height: 1050 });
  const control = (key: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyUp", value: KEY.control }]);
  const activate = async (selector: string) => { const el = await wd.waitFor(selector, 20000); await wd.execute('arguments[0].focus()', el); await wd.keys([{ type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }]); };
  const fill = async (selector: string, text: string) => { const el = await wd.waitFor(selector, 20000); await wd.click(el); await control("a"); await wd.sendKeys(el, text); };
  const click = async (text: string, selector = "button") => {
    if (!await until(async () => { for (const el of await wd.findAll(selector)) if (await wd.displayed(el) && await wd.execute<boolean>('return arguments[0].textContent.trim()===arguments[1]', el, text)) { await wd.click(el); return true; } return false; }, 10000)) throw new Error(`Missing ${text}`);
  };
  const ribbon = async (name: string) => { if (!await wd.execute<boolean>('return [...document.querySelectorAll(".ribbon-tab.active")].some(el=>el.textContent.trim()===arguments[0])', name)) await click(name, ".ribbon-tab"); };
  const pdfFrame = async () => { await wd.frame(null); await wd.frame(await wd.waitFor(`${pane} iframe.office-frame[src*="/pdf.html"]`, 20000)); await wd.waitFor('.pdf-page[data-page="0"]', 30000); };
  const source = async () => { await wd.frame(null); await activate(`${pane} [data-tab-id="pdf-convert-source"] [role="tab"]`); await pdfFrame(); };
  const menu = async (name: string) => { await ribbon("홈"); await click("PDF 변환", ".ribbon .rb-big"); await click(name, ".rb-drop button"); };
  const output = async (path: string) => { await wd.frame(null); await fill('input[aria-label="저장할 파일 경로"]', path); await activate('.office-output-dialog button[type="submit"]'); };
  const work = await api<Work>("POST", "/api/works", { title: S, cwd: null }), main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const pdf = await PDFDocument.create();
  for (let p = 0; p < 2; p++) pdf.addPage([400, 600]).drawText(`Original page ${p + 1} content`, { x: 30, y: 550, size: 16 });
  for (const size of [64, 16]) {
    const png = new PNG({ width: size, height: size }); png.data.fill(255);
    const image = await pdf.embedPng(PNG.sync.write(png));
    for (const page of pdf.getPages()) page.drawImage(image, { x: 30, y: 300, width: size, height: size });
  }
  const original = Buffer.from(await pdf.save()), path = join(work.cwd, "변환 원본.pdf"); writeFileSync(path, original);
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path });
  const tab = { id: "pdf-convert-source", workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "pdf-convert-pane", panes: [{ ...tab, id: "pdf-convert-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.refresh(); await installProbe(wd); await pdfFrame(); await installProbe(wd);
  phase = "cancel Office output"; await menu("Word로 변환"); await wd.frame(null); await wd.waitFor(".office-output-dialog"); await click("취소", ".office-output-dialog button"); await pdfFrame();
  report.check(S, "변환 위치 취소는 새 파일과 원문 변경 없음", !existsSync(join(work.cwd, "변환 원본.docx")) && readFileSync(path).equals(original));
  for (const [format, label, page, xml] of [["docx", "Word로 변환", "docs", "word/document.xml"], ["xlsx", "Excel로 변환", "sheets", "xl/worksheets/sheet1.xml"], ["pptx", "PPT로 변환", "slides", "ppt/slides/slide1.xml"]] as const) {
    phase = `convert ${format}`; await menu(label); const target = join(work.cwd, `결과.${format}`); await output(target);
    if (!await until(async () => existsSync(target), 45000)) throw new Error(`${format} output missing`);
    await wd.frame(await wd.waitFor(`${pane} iframe.office-frame[src*="/${page}.html"]`, 30000));
    const rendered = format === "xlsx" ? 'return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중")' : format === "pptx" ? 'return !!window.Konva?.stages?.some(stage=>stage.find("Text").map(node=>node.text()).join("").replaceAll(" ","").includes("Originalpage1content"))' : 'return document.body.textContent.includes("Original page 1 content")';
    if (!await until(() => wd.execute<boolean>(rendered), 40000)) throw new Error(`${format} editor content did not render`);
    await wd.frame(null);
    const zip = await JSZip.loadAsync(readFileSync(target)), body = await zip.file(xml)!.async("string");
    report.check(S, `${format} 원본 변환 결과와 해당 편집기 탭 열기`, body.includes(format === "xlsx" ? "<row" : "Original page 1 content"), undefined, await shot(ctx, `${format}-opened.png`));
    await source();
  }
  report.check(S, "3형식 변환은 원문 파일·판 유지", readFileSync(path).equals(original) && (await snapshot()).artifacts.find(a => a.id === artifact.id)?.revision === 1);
  for (const format of ["md", "epub"] as const) {
    phase = `convert ${format}`; await menu(format === "md" ? "Markdown으로 변환" : "EPUB으로 변환"); await wd.waitFor(".pdf-convert-dialog");
    await wd.click(await wd.waitFor('[data-field="some-pages"]')); await fill('[data-field="range"]', "2");
    if (format === "epub") { await fill('[data-field="title"]', "Converted book"); await fill('[data-field="author"]', "Test author"); }
    await activate('[data-action="choose-target"]'); const target = join(work.cwd, `범위 결과.${format}`); await output(target); await pdfFrame();
    await activate('[data-action="convert"]');
    if (!await until(async () => existsSync(target), 45000)) throw new Error(`${format} output missing`);
    if (format === "epub") await wd.waitFor('[data-action="open-folder"]', 20000);
    if (format === "md") {
      const body = readFileSync(target, "utf8"); report.check(S, "Markdown 범위 선택·원본 내용 출력", body.includes("Original page 2 content") && !body.includes("Original page 1 content"));
      if (await wd.find('[data-action="open-md"]')) await activate('[data-action="open-md"]');
      await wd.frame(null); await wd.frame(await wd.waitFor(`${pane} iframe.office-frame[src*="/markdown.html"]`, 20000));
      if (!await until(() => wd.execute<boolean>('return document.body.textContent.includes("Original page 2 content")'), 20000)) throw new Error("Converted Markdown did not render");
      await source();
    } else {
      const zip = await JSZip.loadAsync(readFileSync(target)); const text = (await Promise.all(Object.values(zip.files).filter(f => /\.(xhtml|opf)$/.test(f.name)).map(f => f.async("string")))).join("\n");
      report.check(S, "EPUB 범위·제목·저자 보존", text.includes("Original page 2 content") && !text.includes("Original page 1 content") && text.includes("Converted book") && text.includes("Test author"));
      await activate('[data-action="close"]');
    }
  }
  const imageParent = join(work.cwd, "그림 결과"); mkdirSync(imageParent); writeFileSync(join(imageParent, "existing.png"), "preserve existing");
  phase = "cancel image output"; await ribbon("홈"); await activate('[data-action="export-images"]'); await activate('[data-action="export-whole-pages"]'); await wd.frame(null); await wd.waitFor('input[aria-label="그림을 저장할 폴더"]'); await click("취소", ".office-output-dialog button"); await pdfFrame();
  report.check(S, "그림 출력 취소는 폴더·기존 파일 유지", readdirSync(imageParent).length === 1 && readFileSync(path).equals(original));
  phase = "whole pages"; await ribbon("페이지"); await click("오른쪽으로 회전", ".ribbon .rb-big"); await ribbon("홈");
  await activate('[data-action="export-images"]'); await activate('[data-action="export-whole-pages"]'); await wd.frame(null); await fill('input[aria-label="그림을 저장할 폴더"]', imageParent); await activate('.office-output-dialog button[type="submit"]');
  if (!await until(async () => readdirSync(imageParent).length === 2, 20000)) throw new Error("Whole-page images missing");
  const whole = join(imageParent, readdirSync(imageParent).find(name => name !== "existing.png")!);
  if (!await until(async () => readdirSync(whole).length === 2, 20000)) throw new Error("Whole-page images incomplete");
  const pages = readdirSync(whole).sort().map(name => PNG.sync.read(readFileSync(join(whole, name))));
  report.check(S, "원본150dpi 페이지 PNG·회전 반영", pages[0].width === 1250 && pages[0].height === 833 && pages[1].width === 833 && pages[1].height === 1250);
  const savedPdf = readFileSync(path); report.check(S, "그림 출력 전 미저장 PDF 편집을 원본 정책대로 저장", !savedPdf.equals(original) && (await PDFDocument.load(savedPdf)).getPages()[0].getRotation().angle === 90);
  await pdfFrame();
  phase = "embedded images"; await activate('[data-action="export-images"]'); await activate('[data-action="export-embedded-images"]'); await wd.frame(null); await fill('input[aria-label="그림을 저장할 폴더"]', imageParent); await activate('.office-output-dialog button[type="submit"]'); await pdfFrame();
  if (!await until(async () => readdirSync(imageParent).length === 3, 20000)) throw new Error("Embedded image folder missing");
  const embedded = join(imageParent, readdirSync(imageParent).find(name => name !== "existing.png" && join(imageParent, name) !== whole)!);
  if (!await until(async () => readdirSync(embedded).length === 1, 20000)) throw new Error("Embedded image extraction incomplete");
  const picture = PNG.sync.read(readFileSync(join(embedded, readdirSync(embedded)[0]!)));
  report.check(S, "내장 그림은64px 원해상도·중복/작은 그림 제외", picture.width === 64 && picture.height === 64 && readdirSync(embedded).length === 1);
  report.check(S, "기존 그림·출력·PDF를 다시 덮어쓰지 않음", readFileSync(join(imageParent, "existing.png"), "utf8") === "preserve existing" && readFileSync(path).equals(savedPdf) && readdirSync(whole).length === 2);
  report.check(S, "PDF 화면 예외 없음", !(await pageErrors(wd)).length, undefined, await shot(ctx, "images-done.png")); await wd.frame(null);
  report.check(S, "부모 화면 예외 없음", !(await pageErrors(wd)).length);
  phase = "encrypted PDF";
  const encryptedPath = join(work.cwd, "암호 문서.pdf"), encrypted = readFileSync(resolve("vendor/ieumoffice/apps/shell/tests/fixtures/testPassword4Spaces.pdf")); writeFileSync(encryptedPath, encrypted);
  const protectedArtifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: encryptedPath });
  const protectedTab = { ...tab, id: "pdf-encrypted-source", view: { kind: "document", artifactId: protectedArtifact.id, proposalId: null } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "pdf-convert-pane", panes: [{ ...protectedTab, id: "pdf-convert-pane", tabs: [protectedTab], activeTabId: protectedTab.id, recentTabIds: [protectedTab.id] }] } });
  await wd.refresh(); await wd.frame(await wd.waitFor(`${pane} iframe.office-frame[src*="/pdf.html"]`, 20000));
  await fill('.pdf-pwd-dialog input[type="password"]', "    "); await activate('.pdf-pwd-dialog .primary'); await wd.waitFor('.pdf-page[data-page="0"]', 20000);
  await menu("Word로 변환"); const canceledPath = join(work.cwd, "암호 취소.docx"); await output(canceledPath); await pdfFrame();
  await fill('[data-pdf-office-conversion] input[type="password"]', "incorrect"); await activate('[data-pdf-office-conversion] .pdf-pwd-dialog .primary'); await wd.waitFor('[data-pdf-office-conversion] .pdf-pwd-error', 20000);
  report.check(S, "변환 암호 오류는 원본 암호 대화상자에서 재입력 안내", true);
  await click("취소", '[data-pdf-office-conversion] .pdf-modal-actions button');
  if (!await until(() => wd.execute<boolean>('return !document.querySelector("[data-pdf-office-conversion]")'), 5000)) throw new Error("Password cancel did not settle");
  report.check(S, "암호 요청 취소는 변환 파일을 만들지 않음", !existsSync(canceledPath) && readFileSync(encryptedPath).equals(encrypted));
  await menu("Word로 변환"); const unlockedPath = join(work.cwd, "암호 결과.docx"); await output(unlockedPath); await pdfFrame();
  await fill('[data-pdf-office-conversion] input[type="password"]', "    "); await activate('[data-pdf-office-conversion] .pdf-pwd-dialog .primary');
  if (!await until(async () => existsSync(unlockedPath), 30000)) throw new Error("Password conversion output missing");
  report.check(S, "공백 암호를 보존해 실제 Word 변환 성공·암호 원문 불변", (await JSZip.loadAsync(readFileSync(unlockedPath))).file("word/document.xml") !== null && readFileSync(encryptedPath).equals(encrypted));
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return {text:document.body.innerText,html:document.documentElement.outerHTML,konva:window.Konva?.stages?.map(s=>s.find("Text").map(n=>n.text()))}').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally { await stage.close(); report.write({ binary, modelCalls: 0, source: "original PDF menus, synthetic two-page PDF and actual converters" }); console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1; }
