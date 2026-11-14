import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Artifact, DocumentPresence, Session, Snapshot, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";
const { PDFDocument, PDFName, PDFHexString } = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url))("pdf-lib");

const binary = resolve(process.argv[2]!), outDir = resolve(process.argv[3]!); mkdirSync(outDir, { recursive: true });
process.env.XDG_CURRENT_DESKTOP = "GNOME";
const report = new Report(outDir), S = "PDF 노트 연결", stage = await openStage(outDir, { privateKeyring: true, nativeX11: true });
let ctx: Ctx | null = null, phase = "start";
try {
  const launch = { binary, engines: "stand-in" as const, profile: "pdf-notes" };
  ctx = { stage, app: await stage.launch({ ...launch, name: "pdf-notes" }), report }; await startScenario(ctx);
  let wd = ctx.app.wd; await wd.setWindowRect({ width: 1700, height: 1050 });
  const api = <T>(method: string, path: string, body?: unknown) => ctx!.app.api<T>(method, path, body), snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const pane = '.pane[data-tab-active="true"]:not([hidden])';
  const control = (key: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyUp", value: KEY.control }]);
  const click = async (text: string, selector = "button") => {
    if (!await until(async () => { for (const el of await wd.findAll(selector)) if (await wd.displayed(el) && await wd.execute<boolean>('return arguments[0].textContent.trim()===arguments[1]', el, text)) { await wd.click(el); return true; } return false; }, 10000)) throw new Error(`Missing button: ${text}`);
  };
  const ribbon = async (text: string) => {
    // Pressing the original active tab collapses the ribbon, so retain an open tab.
    if (!await wd.execute<boolean>('return [...document.querySelectorAll(".ribbon-tab.active")].some(el=>el.textContent.trim()===arguments[0])', text)) await click(text, ".ribbon-tab");
  };
  const enter = async (kind: "pdf" | "markdown") => {
    await wd.frame(null);
    const selector = `${pane} iframe.office-frame[src*="/${kind}.html"]`;
    if (!(await wd.findAll(selector)).length) {
      const choice = await wd.waitFor(`${pane} button[aria-label="표시할 칸"]`);
      await wd.execute('arguments[0].focus()', choice);
      const key = kind === "pdf" ? "\ue011" : "\ue010";
      await wd.keys([{ type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }]);
    }
    await wd.frame(await wd.waitFor(selector, 20000));
    await wd.waitFor(kind === "pdf" ? '.pdf-page[data-page="0"]' : '.tiptap[contenteditable="true"]', 30000); await installProbe(wd);
  };
  const work = await api<Work>("POST", "/api/works", { title: S, cwd: null }), main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const pdf = await PDFDocument.create(), page = pdf.addPage([500, 700]); page.drawText("PDF original reading note", { x: 40, y: 650, size: 16 });
  const annotation = pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Text", Rect: [50, 500, 75, 525], Contents: PDFHexString.fromText("PDF_NOTE_BODY"), T: PDFHexString.fromText("Note author"), Name: "Comment", F: 4, C: [1, 1, 0] }));
  page.node.set(PDFName.of("Annots"), pdf.context.obj([annotation]));
  const original = Buffer.from(await pdf.save()), path = join(work.cwd, "Source (one).pdf"), notePath = join(work.cwd, "Existing note.md"); writeFileSync(path, original);
  const noteOriginal = '---\r\n"DIKM_단계:": ""\r\nunknown: null\r\n---\r\n# Existing note\r\n\r\nKEEP_EXISTING_BODY\r\n'; writeFileSync(notePath, noteOriginal);
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path }), note = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: notePath });
  const pdfTab = { id: "pdf-notes-source", workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } };
  const noteTab = { id: "pdf-notes-note", workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: note.id, proposalId: null }, ui: { mode: "rich" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "pdf-notes-pane", panes: [
    { ...pdfTab, id: "pdf-notes-pane", tabs: [pdfTab], activeTabId: pdfTab.id, recentTabIds: [pdfTab.id] },
    { ...noteTab, id: "pdf-note-pane", tabs: [noteTab], activeTabId: noteTab.id, recentTabIds: [noteTab.id] },
  ] } });
  await wd.refresh(); await installProbe(wd); await enter("pdf");
  phase = "cancel note picker"; await ribbon("보기"); await wd.click(await wd.waitFor('[data-action="note-open"]'));
  await wd.frame(null); await wd.waitFor('.pdf-note-dialog');
  report.check(S, "원본 노트 열기 버튼과 기본 파일 이름", (await wd.attribute(await wd.waitFor('input[aria-label="PDF 노트 파일"]'), "value"))?.endsWith("Source (one) 노트.md") === true);
  await click("취소", ".pdf-note-dialog button"); await enter("pdf");
  report.check(S, "취소 시 새 파일·원문·기존 노트 변경 없음", !existsSync(join(work.cwd, "Source (one) 노트.md")) && readFileSync(path).equals(original) && readFileSync(notePath, "utf8") === noteOriginal);
  phase = "link existing note"; await ribbon("페이지"); await click("오른쪽으로 회전", ".ribbon .rb-big"); await ribbon("보기");
  await wd.click(await wd.waitFor('[data-action="note-open"]')); await wd.frame(null);
  const input = await wd.waitFor('input[aria-label="PDF 노트 파일"]'); await wd.click(input); await control("a"); await wd.sendKeys(input, notePath); await click("노트 연결", ".pdf-note-dialog button"); await enter("markdown");
  report.check(S, "기존 노트를 같은 작업공간의 원본 Markdown 탭으로 열기", await wd.execute<boolean>('return document.querySelector(".tiptap").textContent.includes("KEEP_EXISTING_BODY")') && readFileSync(notePath, "utf8") === noteOriginal);
  report.check(S, "노트 열기는 편집 중인 PDF를 강제로 저장하지 않음", readFileSync(path).equals(original) && (await api<{ views: DocumentPresence[] }>("GET", "/api/document-views")).views.some(view => view.artifactId === artifact.id && view.dirty));
  const editor = await wd.waitFor('.tiptap[contenteditable="true"]'); await wd.click(editor); await control("\ue010"); await wd.sendKeys(editor, KEY.enter); await wd.sendKeys(editor, "LOCAL_UNSAVED_DRAFT");
  if (!await until(() => wd.execute<boolean>('return document.querySelector(".tiptap").textContent.includes("LOCAL_UNSAVED_DRAFT")'), 5000)) throw new Error("Note draft missing");
  const beforeAppend = readFileSync(notePath, "utf8");
  writeFileSync(report.path("before-append.md"), beforeAppend);
  report.check(S, "분할 화면에서 노트 초안과 PDF 편집이 둘 다 미저장 상태", beforeAppend === noteOriginal && (await api<{ views: DocumentPresence[] }>("GET", "/api/document-views")).views.filter(view => [artifact.id, note.id].includes(view.artifactId) && view.dirty).length === 2);
  phase = "append from original annotation panel"; await enter("pdf"); await ribbon("보기"); await click("주석", ".ribbon .rb-big");
  await wd.waitFor('[data-action="note-insert"]', 15000); await wd.click(await wd.waitFor('[data-action="note-insert"]')); await enter("markdown");
  if (!await until(() => wd.execute<boolean>('return document.querySelector(".tiptap").textContent.includes("PDF_NOTE_BODY")'), 10000)) throw new Error("Original note append did not reach Markdown");
  report.check(S, "원본 주석의 노트 추가가 기존 편집 내용 뒤에 인용·쪽 링크를 붙임", await wd.execute<boolean>('const e=document.querySelector(".tiptap");return e.textContent.indexOf("LOCAL_UNSAVED_DRAFT")<e.textContent.indexOf("PDF_NOTE_BODY")&&[...e.querySelectorAll("a")].some(a=>a.getAttribute("href").includes("#page=1"))'));
  writeFileSync(report.path("after-append.md"), readFileSync(notePath));
  writeFileSync(report.path("after-append-views.json"), JSON.stringify(await api("GET", "/api/document-views"), null, 2));
  report.check(S, "노트 추가는 원문을 자동 저장하지 않고 편집기에만 반영", readFileSync(notePath, "utf8") === beforeAppend && readFileSync(path).equals(original), undefined, await shot(ctx, "note-appended.png"));
  await wd.click(await wd.waitFor('.tiptap[contenteditable="true"]'));
  await control("z"); report.check(S, "원본 실행 취소로 추가분만 되돌리고 작성 중인 문장은 유지", await until(() => wd.execute<boolean>('const t=document.querySelector(".tiptap").textContent;return t.includes("LOCAL_UNSAVED_DRAFT")&&!t.includes("PDF_NOTE_BODY")'), 5000));
  await control("y"); if (!await until(() => wd.execute<boolean>('return document.querySelector(".tiptap").textContent.includes("PDF_NOTE_BODY")'), 5000)) throw new Error("Original note redo failed");
  const serializedBody = "PDF\\_NOTE\\_BODY"; // The original serializer escapes underscores in new text.
  await control("s"); if (!await until(async () => readFileSync(notePath, "utf8").includes(serializedBody), 10000)) throw new Error("Explicit note save failed");
  const saved = readFileSync(notePath, "utf8"); writeFileSync(report.path("saved-note.md"), saved); report.check(S, "명시 저장에 인용·초안·기존 메타데이터 보존", saved.includes('"DIKM_단계:": ""') && saved.includes("unknown: null") && saved.includes("LOCAL\\_UNSAVED\\_DRAFT") && saved.includes("Source%20%28one%29.pdf#page=1") && saved.split(serializedBody).length === 2);
  report.check(S, "Markdown 화면 예외 없음", (await pageErrors(wd)).length === 0);
  phase = "reopen without duplicate"; await enter("pdf"); await wd.click(await wd.waitFor('[data-action="note-open"]')); await enter("markdown");
  report.check(S, "다시 열 때 위치를 묻지 않고 같은 노트·한 번만 삽입", await wd.execute<boolean>('return document.querySelector(".tiptap").textContent.split("PDF_NOTE_BODY").length===2') && readFileSync(notePath, "utf8") === saved);
  await wd.frame(null); report.check(S, "부모 화면 예외 없음", (await pageErrors(wd)).length === 0);
  phase = "app restart"; await ctx.app.close(); ctx.app = await stage.launch({ ...launch, name: "pdf-notes-restarted" }); wd = ctx.app.wd;
  await enter("pdf"); await ribbon("보기"); await wd.click(await wd.waitFor('[data-action="note-open"]')); await enter("markdown");
  report.check(S, "앱 재시작 뒤 PDF→노트 연결과 저장 내용 유지", await wd.execute<boolean>('return document.querySelector(".tiptap").textContent.includes("PDF_NOTE_BODY")') && readFileSync(notePath, "utf8") === saved && readFileSync(path).equals(original));
  const views = (await api<{ views: DocumentPresence[] }>("GET", "/api/document-views")).views.filter(view => [artifact.id, note.id].includes(view.artifactId));
  report.check(S, "노트는 별도 문서 AI 대화로 연결", new Set(views.map(view => view.artifactId)).size === 2 && views.every((view, _, list) => list.every(other => view.artifactId === other.artifactId || view.sessionId !== other.sessionId)));
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return {text:document.body.innerText,html:document.documentElement.outerHTML}').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally { await stage.close(); report.write({ binary, modelCalls: 0, source: "synthetic PDF annotation and existing Markdown; original buttons and native keys" }); console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1; }
