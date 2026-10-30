import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Artifact, DocumentPresence, Snapshot, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";
const require = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument } = require("pdf-lib");

export async function pdfOfficeScenario(ctx: Ctx) {
  const S = "27 PDF 원본 편집기", { wd, api } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "PDF 이음 편집 검사", cwd: null });
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]).drawText("Original searchable PDF", { x: 30, y: 550, size: 18 });
  doc.addPage([500, 700]).drawText("Second original page", { x: 30, y: 650, size: 18 });
  const file = join(work.cwd, "PDF 원본 편집.pdf"), original = Buffer.from(await doc.save({ useObjectStreams: false }));
  writeFileSync(file, original);
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const tab = { id: "pdf-tab", workId: work.id, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "pdf-pane", panes: [{ ...tab, id: "pdf-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
  await wd.frame(await wd.waitFor("iframe.office-frame", 30000)); await installProbe(wd);
  const clickLabel = async (selector: string, labels: string[]) => {
    if (!await until(async () => {
      for (const button of await wd.findAll(selector)) if (labels.includes((await wd.execute<string>("return arguments[0].textContent.trim();", button))) && await wd.displayed(button)) { await wd.click(button); return true; }
      return false;
    }, 15000)) throw new Error(`Missing PDF command: ${labels.join("/")}; ${await wd.execute<string>('return document.body.innerText.slice(0,1200)')}`);
  };
  const saveKey = () => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "s" }, { type: "keyUp", value: "s" }, { type: "keyUp", value: KEY.control }]);
  const loaded = await until(async () => await wd.execute<boolean>('return !!document.querySelector(".pdf-page canvas")?.width && document.body.textContent.includes("Original searchable PDF");'), 45000);
  ctx.report.check(S, "원본 PDF.js 화면·텍스트 레이어를 Electron 없이 열기", loaded, undefined, await shot(ctx, "27-pdf-open.png"));
  if (!loaded) throw new Error(`PDF open failed: ${await wd.execute<string>('return document.body.innerText.slice(0,1500)')}; ${JSON.stringify(await pageErrors(wd))}`);
  await saveKey();
  ctx.report.check(S, "편집 전 저장은 원본 바이트 유지", readFileSync(file).equals(original));
  await clickLabel(".ribbon .rb-big", ["Insert text", "텍스트 삽입"]);
  await wd.sendKeys(await wd.waitFor(".pdf-modal-textarea"), "NATIVE PDF TEXT");
  await wd.click(await wd.waitFor(".pdf-modal-actions .primary"));
  await wd.waitFor(".pdf-page.pdf-inserting-text", 15000);
  await wd.click(await wd.waitFor('.pdf-page[data-page="0"]'));
  await saveKey();
  const savedText = await until(async () => await wd.execute<boolean>('return [...document.querySelectorAll(".textLayer")].some(layer=>layer.textContent.includes("NATIVE PDF TEXT"));'), 20000);
  ctx.report.check(S, "원본 삽입 UI·글꼴 확인·검색 가능한 글자 저장", savedText, undefined, await shot(ctx, "27-pdf-text.png"));
  if (!savedText) throw new Error(`PDF text was not saved: ${await wd.execute<string>('return document.body.innerText.slice(0,1600)')}`);
  await clickLabel(".ribbon-tab", ["페이지"]);
  await clickLabel(".ribbon .rb-big", ["오른쪽으로 회전"]);
  await saveKey();
  ctx.report.check(S, "페이지 회전 저장", await until(async () => (await PDFDocument.load(readFileSync(file))).getPage(0).getRotation().angle === 90, 15000));
  await clickLabel(".ribbon .rb-big", ["빈 페이지 삽입"]);
  await saveKey();
  ctx.report.check(S, "빈 페이지 삽입 저장", await until(async () => (await PDFDocument.load(readFileSync(file))).getPageCount() === 3, 15000));
  // Cross three independently saved PDF bases, not merely the pending overlays.
  // Each undo/redo is a real original control and a new on-disk document revision.
  const revision = async () => (await snapshot()).artifacts.find((a) => a.id === artifact.id)!.revision;
  for (const fault of ["unavailable", "corrupt"]) {
    await wd.waitFor('button[aria-label^="실행 취소"]:not(:disabled)', 15000);
    const before = await revision(), bytes = readFileSync(file);
    await wd.execute(`window.__pdfUndoFetch = window.fetch; window.__pdfUndoFault = false;
      window.fetch = async (...args) => {
        if (!window.__pdfUndoFault && String(args[0]).includes('/raw?revision=')) {
          window.__pdfUndoFault = true;
          return new Response('synthetic invalid PDF', {status: arguments[0] === 'corrupt' ? 200 : 503});
        }
        return window.__pdfUndoFetch(...args);
      };`, fault);
    try {
      await wd.click(await wd.waitFor('button[aria-label^="실행 취소"]:not(:disabled)'));
      const settled = await until(() => wd.execute<boolean>('return window.__pdfUndoFault && document.querySelector(".app")?.getAttribute("aria-busy") === "false" && !!document.querySelector("button[aria-label^=\\"실행 취소\\"]:not(:disabled)");'), 15000);
      const intact = settled && await revision() === before && readFileSync(file).equals(bytes) && await wd.execute<boolean>('return !!document.querySelector("button[aria-label^=\\"다시 실행\\"]:disabled") && [...document.querySelectorAll(".textLayer")].some(layer=>layer.textContent.includes("NATIVE PDF TEXT"));');
      ctx.report.check(S, `과거 PDF ${fault} 실패에도 파일·화면·되돌림 위치 보존`, intact, undefined, await shot(ctx, `27-pdf-history-${fault}.png`));
      if (!intact) throw new Error(`PDF history ${fault} failure changed the current document`);
    } finally { await wd.execute('window.fetch = window.__pdfUndoFetch;'); }
  }
  for (const step of [
    { action: "undo", pages: 2, rotation: 90, text: true, label: "빈 페이지" },
    { action: "undo", pages: 2, rotation: 0, text: true, label: "회전" },
    { action: "undo", pages: 2, rotation: 0, text: false, label: "글자 삽입" },
    { action: "redo", pages: 2, rotation: 0, text: true, label: "글자 삽입" },
    { action: "redo", pages: 2, rotation: 90, text: true, label: "회전" },
    { action: "redo", pages: 3, rotation: 90, text: true, label: "빈 페이지" },
  ]) {
    const before = await revision();
    const delayRead = step.action === "undo" && step.label === "빈 페이지";
    if (delayRead) await wd.execute(`window.__pdfUndoFetch = window.fetch; window.__pdfUndoReadWaiting = false;
      window.fetch = async (...args) => {
        if (!window.__pdfUndoReadWaiting && String(args[0]).includes('/raw?revision=')) {
          window.__pdfUndoReadWaiting = true;
          await new Promise(resolve => { window.__pdfUndoReadRelease = resolve; });
        }
        return window.__pdfUndoFetch(...args);
      };`);
    await wd.click(await wd.waitFor(`button[aria-label^="${step.action === "undo" ? "실행 취소" : "다시 실행"}"]:not(:disabled)`, 15000));
    if (delayRead) {
      try {
        const dirty = await until(async () => {
          const waiting = await wd.execute<boolean>('return window.__pdfUndoReadWaiting && document.querySelector(".app")?.getAttribute("aria-busy") === "true";');
          const { views } = await api<{ views: DocumentPresence[] }>("GET", "/api/document-views");
          return waiting && views.some((view) => view.artifactId === artifact.id && view.dirty);
        }, 10000);
        ctx.report.check(S, "과거 판을 읽는 동안 상위 문서 등록도 저장 전 상태로 유지", dirty && await revision() === before);
        if (!dirty) throw new Error("PDF history restore was incorrectly advertised as clean");
      } finally { await wd.execute('window.__pdfUndoReadRelease?.(); window.fetch = window.__pdfUndoFetch;'); }
    }
    await wd.waitFor(`button[aria-label^="${step.action === "undo" ? "다시 실행" : "실행 취소"}"]:not(:disabled)`, 15000);
    await saveKey();
    const ok = await until(async () => {
      if (await revision() <= before) return false;
      const bytes = readFileSync(file), saved = await PDFDocument.load(bytes);
      const text = await wd.execute<boolean>('return [...document.querySelectorAll(".textLayer")].some(layer=>layer.textContent.includes("NATIVE PDF TEXT"));');
      return saved.getPageCount() === step.pages && saved.getPage(0).getRotation().angle === step.rotation && text === step.text && (step.text || bytes.equals(original));
    }, 20000);
    ctx.report.check(S, `${step.label} 저장 후 ${step.action}·실제 PDF 재저장`, ok, `r${before} → r${await revision()}`, await shot(ctx, `27-pdf-${step.action}-${before}.png`));
    if (!ok) throw new Error(`PDF history ${step.action} ${step.label} failed`);
  }
  const firstErrors = await pageErrors(wd);
  await wd.frame(null);
  await clickLabel('.doc-header [role="radio"]', ["미리보기"]);
  ctx.report.check(S, "원본 편집기 저장 후 미리보기 전환", await until(async () => await wd.execute<boolean>('return !document.querySelector("iframe.office-frame") && [...document.querySelectorAll(".doc-header [role=radio]")].some(button=>button.textContent.trim()==="미리보기" && button.getAttribute("aria-checked")==="true");'), 15000), undefined, await shot(ctx, "27-pdf-preview.png"));
  await clickLabel('.doc-header [role="radio"]', ["편집"]);
  await wd.frame(await wd.waitFor("iframe.office-frame", 15000)); await installProbe(wd);
  ctx.report.check(S, "새 판 재열기·삽입한 글자 보존", await until(async () => await wd.execute<boolean>('return [...document.querySelectorAll(".textLayer")].some(layer=>layer.textContent.includes("NATIVE PDF TEXT"));'), 20000));
  await clickLabel(".ribbon-tab", ["페이지"]);
  await clickLabel(".ribbon .rb-big", ["모두 회전"]);
  const external = await PDFDocument.create(); external.addPage([600, 800]).drawText("EXTERNAL PDF", { x: 30, y: 650 });
  const externalBytes = Buffer.from(await external.save()); writeFileSync(file, externalBytes);
  await api("POST", `/api/artifacts/${artifact.id}/adopt-disk`);
  await saveKey();
  // Wait for the original save's rejected result and its real serialized recovery bytes.
  await until(async () => await wd.execute<boolean>('return !document.querySelector(".qa-btn[aria-label=저장]")?.disabled;'), 10000);
  await wd.frame(null); await wd.waitFor(".doc-conflict", 15000);
  ctx.report.check(S, "충돌 저장 거절·외부 PDF 바이트 보존", readFileSync(file).equals(externalBytes));
  await wd.refresh(); await installProbe(wd);
  await wd.frame(await wd.waitFor("iframe.office-frame", 15000)); await installProbe(wd);
  const recovered = await until(async () => await wd.execute<boolean>('return [...document.querySelectorAll(".textLayer")].some(layer=>layer.textContent.includes("NATIVE PDF TEXT"));'), 20000);
  ctx.report.check(S, "새로고침 뒤 실제 PDF 복구본 재열기", recovered && readFileSync(file).equals(externalBytes));
  await wd.frame(null);
  await clickLabel(".doc-conflict button", ["내 편집을 새 판으로"]);
  const rebased = await until(async () => { const saved = await PDFDocument.load(readFileSync(file)); return saved.getPageCount() === 3 && saved.getPage(0).getRotation().angle === 180; }, 20000);
  ctx.report.check(S, "명시적 충돌 해결은 복구 PDF 전체를 새 판으로 저장", rebased);
  const state = await snapshot();
  ctx.report.check(S, "PDF 저장을 문서 판 이력으로 기록", state.artifacts.find((a) => a.id === artifact.id)!.revision >= 5);
  await wd.frame(await wd.waitFor("iframe.office-frame"));
  const lastErrors = await pageErrors(wd); await wd.frame(null);
  ctx.report.check(S, "PDF 편집기·상위 앱 예외 없음", !firstErrors.length && !lastErrors.length && !(await pageErrors(wd)).length, [...firstErrors, ...lastErrors].join("\n") || undefined, await shot(ctx, "27-pdf-recovered.png"));
}
