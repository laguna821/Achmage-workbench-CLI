import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Artifact, ArtifactRevision, Session, Snapshot, Work } from "@workbench/contracts";
import { installProbe, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";
const require = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument, PDFName, PDFString, PDFArray } = require("pdf-lib");
const { PNG } = require("pngjs");
const readText = (path: string) => execFileSync("pdftotext", [path, "-"], { encoding: "utf8" });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const subtypes = (doc: any): string[] => (doc.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []).map((r: any) => doc.context.lookup(r).get(PDFName.of("Subtype")).toString());

/** Native input drives the original modal and actual irreversible-redaction
 * confirmation. Only synthetic PDFs and an isolated host/profile are used. */
export async function pdfCopiesScenario(ctx: Ctx) {
  const S = "PDF 사본과 영구 가림", { wd, api } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "PDF 사본 검증", cwd: null });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const doc = await PDFDocument.create(), page = doc.addPage([400, 600]);
  page.drawText("SECRET COPY TEXT", { x: 30, y: 550, size: 18 });
  page.drawText("Public content stays", { x: 30, y: 500, size: 18 });
  page.node.set(PDFName.of("Annots"), doc.context.obj([
    { Type: "Annot", Subtype: "Link", Rect: [20, 20, 100, 40], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.com") } },
    { Type: "Annot", Subtype: "Text", Rect: [60, 400, 80, 420], Contents: PDFString.of("ORIGINAL NOTE"), T: PDFString.of("GenOffice"), C: [1, 1, 0] },
    { Type: "Annot", Subtype: "Highlight", Rect: [40, 200, 140, 220], QuadPoints: [40, 220, 140, 220, 40, 200, 140, 200], C: [1, 1, 0] },
  ].map((item) => doc.context.register(doc.context.obj(item)))));
  const field = doc.getForm().createTextField("Reader"); field.setText("Ada"); field.addToPage(page, { x: 30, y: 300, width: 150, height: 25 });
  const source = join(work.cwd, "Original.pdf"), original = Buffer.from(await doc.save({ useObjectStreams: false }));
  writeFileSync(source, original);
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: source });
  const key = (value: string, shift = false) => wd.keys([{ type: "keyDown", value: KEY.control }, ...(shift ? [{ type: "keyDown" as const, value: KEY.shift }] : []), { type: "keyDown", value }, { type: "keyUp", value }, ...(shift ? [{ type: "keyUp" as const, value: KEY.shift }] : []), { type: "keyUp", value: KEY.control }]);
  const enter = async (name?: string) => { await wd.frame(null); await wd.frame(await wd.waitFor(`iframe.office-frame${name ? `[title*="${name}"]` : ""}`, 30000)); };
  const open = async (item: Artifact) => {
    await wd.frame(null);
    const tab = { id: "pdf-copy-tab", workId: work.id, sessionId: session.id, view: { kind: "document", artifactId: item.id, proposalId: null }, ui: { mode: "edit" } };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "pdf-copy-pane", panes: [{ ...tab, id: "pdf-copy-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.refresh(); await installProbe(wd); await enter(item.name); await installProbe(wd);
    if (!await until(() => wd.execute<boolean>('return !!document.querySelector(".pdf-page canvas")?.width && document.querySelector(".textLayer")?.textContent.includes("Public content stays")'), 45000)) throw new Error(`PDF did not render: ${item.name}`);
  };
  const clickText = async (selector: string, text: string | string[]) => {
    const labels = Array.isArray(text) ? text : [text];
    if (!await until(async () => {
      for (const button of await wd.findAll(selector)) if (await wd.displayed(button) && labels.includes(await wd.execute<string>("return arguments[0].textContent.trim()", button))) { await wd.click(button); return true; }
      return false;
    }, 15000)) throw new Error(`Missing PDF control: ${text}`);
  };
  const startCopy = async (toolbar = false) => {
    if (toolbar) await wd.click(await wd.waitFor('button[aria-label="다른 이름으로 저장"]')); else await key("s", true);
    await wd.frame(null); await wd.waitFor(".office-output-dialog", 15000);
  };
  const choose = async (target: string, keepSource = true) => {
    const field = await wd.waitFor('.office-output-dialog input[aria-label="저장할 파일 경로"]');
    await wd.click(field); await key("a"); await wd.sendKeys(field, target); await wd.click(await wd.waitFor('.office-output-dialog button[type="submit"]'));
    if (keepSource) await enter();
  };
  const annotations = async (mode: number) => {
    await wd.waitFor('input[name="save-copy-annotations"]');
    await wd.click((await wd.findAll('input[name="save-copy-annotations"]'))[mode]!);
    await wd.click(await wd.waitFor('.pdf-modal-actions .primary'));
  };
  const unlocked = () => until(() => wd.execute<boolean>('return !document.querySelector(".workbench-copy-progress") && !document.querySelector("input[name=save-copy-annotations]")'), 20000);
  const pristine = async () => hash(readFileSync(source)) === hash(original) && (await snapshot()).artifacts.find((a) => a.id === artifact.id)?.revision === 1;
  const markRedaction = async () => {
    await clickText(".ribbon-tab", "주석"); await clickText(".ribbon .rb-big", "영역 마스킹");
    const box = await wd.execute<{ left: number; top: number; width: number; height: number }>('const r=document.querySelector(".pdf-redaction-layer").getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}');
    await wd.frame(null); const frame = await wd.waitFor("iframe.office-frame"), outer = await wd.rect(frame);
    const point = (x: number, y: number) => ({ x: Math.round(outer.x + box.left + box.width * x / 400), y: Math.round(outer.y + box.top + box.height * y / 600) });
    await wd.pointer([{ type: "pointerMove", origin: "viewport", ...point(25, 20) }, { type: "pointerDown", button: 0 }, { type: "pointerMove", origin: "viewport", duration: 300, ...point(250, 60) }, { type: "pointerUp", button: 0 }]);
    await enter(); await wd.waitFor(".pdf-redaction-mark");
  };
  await wd.setWindowRect({ width: 1800, height: 1100 }); await open(artifact);
  await wd.execute('window.__pdfCopyOriginal = true');
  const cleanPath = join(work.cwd, "Clean-copy.pdf");
  await startCopy(true); await choose(cleanPath); await annotations(0);
  if (!await until(() => Promise.resolve(existsSync(cleanPath)), 20000)) throw new Error("Clean copy missing");
  ctx.report.check(S, "편집 없는 사본은 실제 원본과 바이트 단위 일치", await unlocked() && readFileSync(cleanPath).equals(original) && await pristine());
  await clickText(".ribbon .rb-big", ["텍스트 삽입", "Insert text"]);
  await wd.sendKeys(await wd.waitFor(".pdf-modal-textarea"), "UNSAVED PDF COPY");
  await wd.click(await wd.waitFor(".pdf-modal-actions .primary")); await wd.waitFor(".pdf-page.pdf-inserting-text");
  await wd.click(await wd.waitFor('.pdf-page[data-page="0"]'));
  await startCopy(true); await enter(); await key("s");
  ctx.report.check(S, "리본 Save As와 위치 선택 중 원본 저장 차단", await pristine() && await wd.execute<boolean>('return !!document.querySelector(".workbench-copy-progress")'));
  await wd.frame(null); await wd.click((await wd.findAll(".office-output-dialog footer button"))[0]!); await enter();
  ctx.report.check(S, "위치 선택 취소 후 원본 편집 유지", await unlocked() && await pristine());
  await startCopy(); await choose(join(work.cwd, "Cancelled.pdf")); await wd.waitFor('input[name="save-copy-annotations"]'); await key("s"); await wd.press(KEY.escape);
  ctx.report.check(S, "주석 선택 Escape 취소와 CtrlS 차단", await unlocked() && await pristine() && !existsSync(join(work.cwd, "Cancelled.pdf")));
  await startCopy(); await choose(join(work.cwd, "Failed.pdf"));
  await wd.execute('const fetch=window.fetch;window.__pdfCopyFailure=false;window.fetch=async(...args)=>{if(String(args[0]).includes("/pdf/copy?")){window.fetch=fetch;window.__pdfCopyFailure=true;return new Response(JSON.stringify({code:"native-copy-unavailable",message:"Synthetic copy connection failure"}),{status:503,headers:{"content-type":"application/json"}})}return fetch(...args)}');
  await annotations(0);
  ctx.report.check(S, "사본 처리 오류 뒤 원본 버퍼·파일 유지", await unlocked() && await wd.execute<boolean>('return window.__pdfCopyFailure === true && window.__pdfCopyOriginal === true') && await pristine() && !existsSync(join(work.cwd, "Failed.pdf")));
  const copies: Artifact[] = [];
  for (const [mode, index] of [["keep", 0], ["flatten", 1], ["strip", 2]] as const) {
    const target = join(work.cwd, `Copy-${mode}.pdf`);
    await startCopy(); await choose(target); await annotations(index);
    if (!await until(async () => (await snapshot()).artifacts.some((a) => a.path === target), 45000)) throw new Error(`PDF ${mode} copy missing`);
    const copy = (await snapshot()).artifacts.find((a) => a.path === target)!; copies.push(copy);
    const loaded = await PDFDocument.load(readFileSync(target)), kinds = subtypes(loaded);
    ctx.report.check(S, `${mode}: 현재 편집을 사본에 저장하고 원본 탭·파일 유지`, await unlocked() && await pristine() && readText(target).includes("UNSAVED PDF COPY") && await wd.execute<boolean>('return window.__pdfCopyOriginal === true'), kinds.join(", "));
    ctx.report.check(S, `${mode}: 선택한 주석 처리와 링크·양식`, mode === "keep" ? kinds.includes("/Text") && kinds.includes("/Highlight") : mode === "flatten" ? !kinds.includes("/Text") && !kinds.includes("/Highlight") : kinds.sort().join() === ["/Link", "/Widget"].join() && loaded.getForm().getTextField("Reader").getText() === "Ada");
    // An annotation can disappear while the PDF parses and its body text is
    // correct. Inspect the actual exported pixels with an independent renderer.
    const pngBytes = execFileSync("pdftoppm", ["-f", "1", "-singlefile", "-r", "72", "-png", target], { maxBuffer: 8 * 1024 * 1024 });
    const png = PNG.sync.read(pngBytes), offset = (390 * png.width + 90) * 4, color = [...png.data.subarray(offset, offset + 4)];
    writeFileSync(ctx.report.path(`pdf-${mode}-appearance.png`), pngBytes);
    ctx.report.check(S, `${mode}: 실제 형광펜 표시의 독립 렌더 검증`, color.join() === (mode === "strip" ? [255, 255, 255, 255] : [255, 255, 0, 255]).join(), color.join());
    const revisions = await api<ArtifactRevision[]>("GET", `/api/artifacts/${copy.id}/revisions`);
    ctx.report.check(S, `${mode}: 원본 판·작업공간·같은 대화 출처`, copy.workspaceId === artifact.workspaceId && revisions[0]?.sessionId === session.id && revisions[0]?.derivedFrom?.some((r) => r.artifactId === artifact.id && r.revision === 1) === true);
    writeFileSync(ctx.report.path(`pdf-${mode}-revisions.json`), JSON.stringify(revisions, null, 2)); copyFileSync(target, ctx.report.path(`pdf-${mode}.pdf`));
  }
  await wd.execute(`window.__pdfCopyRecovery=null;const req=indexedDB.open('workbench-office',1);req.onsuccess=()=>{const db=req.result;const get=db.transaction('recovery','readonly').objectStore('recovery').get(arguments[0]);get.onsuccess=()=>{window.__pdfCopyRecovery=get.result ? Array.from(new Uint8Array(get.result.bytes)) : [];db.close();}}`, artifact.id);
  if (!await until(() => wd.execute<boolean>('return Array.isArray(window.__pdfCopyRecovery)'), 5000)) throw new Error("Source recovery read did not finish");
  const keptBytes = Buffer.from(await wd.execute<number[]>('return window.__pdfCopyRecovery'));
  const kept = await PDFDocument.load(keptBytes); writeFileSync(ctx.report.path("pdf-source-recovery.pdf"), keptBytes);
  ctx.report.check(S, "strip 사본과 원본 복구본 분리: 원본 메모·미저장 본문 보존", subtypes(kept).includes("/Text") && readText(ctx.report.path("pdf-source-recovery.pdf")).includes("UNSAVED PDF COPY"));
  await markRedaction(); await clickText(".ribbon .rb-big", "마스킹 적용");
  ctx.report.check(S, "다른 미저장 편집이 있으면 영구 가림 전에 저장 요구", await wd.execute<boolean>('return document.body.innerText.includes("다른 변경 사항을 먼저 저장")') && await pristine());
  const pendingPath = join(work.cwd, "Pending-redaction-copy.pdf");
  await startCopy(); await choose(pendingPath); await annotations(0);
  if (!await until(() => Promise.resolve(existsSync(pendingPath)), 20000)) throw new Error("Pending redaction ordinary copy missing");
  ctx.report.check(S, "일반 사본은 가림을 적용하지 않고 원본의 보류 표시도 유지", await unlocked() && readText(pendingPath).includes("SECRET COPY TEXT") && !!await wd.find(".pdf-redaction-mark") && await pristine());
  for (const copy of copies) {
    await open(copy);
    ctx.report.check(S, `${copy.name}: 저장한 실제 사본 본문 재열기`, await wd.execute<boolean>('return document.querySelector(".textLayer")?.textContent.includes("UNSAVED PDF COPY") === true'), undefined, await shot(ctx, `pdf-${copy.name}.png`));
  }
  // Use a clean separate artifact: original redaction refuses other pending edits.
  const redactSource = join(work.cwd, "Redaction-source.pdf"); writeFileSync(redactSource, original);
  const redactionArtifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: redactSource });
  await open(redactionArtifact); await markRedaction();
  await key("s");
  ctx.report.check(S, "일반 저장은 표시된 가림 영역을 적용하지 않음", hash(readFileSync(redactSource)) === hash(original));
  const confirm = async (accept: boolean) => {
    await clickText(".ribbon .rb-big", "마스킹 적용");
    const message = await wd.raw<string>("GET", `/session/${wd.sessionId}/alert/text`);
    ctx.report.check(S, "영구 제거에 대한 실제 확인 표시", message.includes("영구적으로 제거"), message);
    await wd.raw("POST", `/session/${wd.sessionId}/alert/${accept ? "accept" : "dismiss"}`, {});
  };
  await confirm(false);
  ctx.report.check(S, "영구 가림 확인 거절은 표시·원본 유지", !!await wd.find(".pdf-redaction-mark") && hash(readFileSync(redactSource)) === hash(original));
  await confirm(true); await wd.frame(null); await wd.waitFor(".office-output-dialog");
  await wd.click((await wd.findAll(".office-output-dialog footer button"))[0]!); await enter();
  ctx.report.check(S, "영구 가림 위치 선택 취소 후 편집 복귀", await unlocked() && !!await wd.find(".pdf-redaction-mark") && hash(readFileSync(redactSource)) === hash(original));
  await confirm(true); await wd.frame(null); await wd.waitFor(".office-output-dialog");
  const redactedPath = join(work.cwd, "Redacted.pdf"); await choose(redactedPath, false);
  if (!await until(async () => (await snapshot()).artifacts.some((a) => a.path === redactedPath), 45000)) throw new Error("Redacted copy missing");
  const redacted = (await snapshot()).artifacts.find((a) => a.path === redactedPath)!;
  await enter("Redacted.pdf");
  if (!await until(() => wd.execute<boolean>('return !!document.querySelector(".pdf-page canvas")?.width && document.querySelector(".textLayer")?.textContent.includes("Public content stays")'), 30000)) throw new Error("Redacted copy did not render");
  const cleanText = readText(redactedPath);
  ctx.report.check(S, "원본 보존과 실제 영구 제거·새 사본 렌더", hash(readFileSync(redactSource)) === hash(original) && !cleanText.includes("SECRET") && cleanText.includes("Public content stays") && await wd.execute<boolean>('return !document.querySelector(".textLayer")?.textContent.includes("SECRET")'), undefined, await shot(ctx, "pdf-redacted.png"));
  ctx.report.check(S, "새 가림 사본은 이전 원본 실행 취소 기록 없음", await wd.execute<boolean>('return document.querySelector("button[aria-label^=\\"실행 취소\\"]")?.disabled === true'));
  await key("z"); await key("s");
  ctx.report.check(S, "사본 실행 취소·저장으로 가려진 원문이 복원되지 않음", !readText(redactedPath).includes("SECRET") && readText(redactSource).includes("SECRET"));
  const revisions = await api<ArtifactRevision[]>("GET", `/api/artifacts/${redacted.id}/revisions`);
  ctx.report.check(S, "가림 사본의 독립 판과 같은 대화 출처", revisions.length === 1 && revisions[0]?.sessionId === session.id && revisions[0]?.derivedFrom?.some((r) => r.artifactId === redactionArtifact.id) === true);
  await wd.execute(`window.__pdfRedactedRecovery=null;const req=indexedDB.open('workbench-office',1);req.onsuccess=()=>{const db=req.result;const get=db.transaction('recovery','readonly').objectStore('recovery').get(arguments[0]);get.onsuccess=()=>{window.__pdfRedactedRecovery=!!get.result;db.close();}}`, redacted.id);
  if (!await until(() => wd.execute<boolean>('return window.__pdfRedactedRecovery !== null'), 5000)) throw new Error("Redacted recovery check did not finish");
  ctx.report.check(S, "가림 사본에 가리기 전 원본 복구 데이터 없음", await wd.execute<boolean>('return window.__pdfRedactedRecovery === false'));
  copyFileSync(redactedPath, ctx.report.path("pdf-redacted.pdf")); writeFileSync(ctx.report.path("pdf-redacted-revisions.json"), JSON.stringify(revisions, null, 2));
  await wd.frame(null);
}
