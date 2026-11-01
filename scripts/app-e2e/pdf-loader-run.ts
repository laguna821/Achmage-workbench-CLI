import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

const binary = resolve(process.argv[2]!), output = resolve(process.argv[3]!), runtime = resolve(process.argv[4]!);
mkdirSync(output, { recursive: true }); const report = new Report(output), stage = await openStage(output, { nativeX11: true }), S = "OpenDataLoader PDF 연결";
let ctx: Ctx | null = null, phase = "start";
try {
  ctx = { stage, app: await stage.launch({ binary, engines: "stand-in", name: "pdf-loader" }), report }; await startScenario(ctx);
  const { wd, api } = ctx.app, snapshot = () => api<Snapshot>("GET", "/api/snapshot"), pane = '.pane[data-tab-active="true"]:not([hidden])';
  mkdirSync(join(ctx.app.dataDir, "pdf-loader"), { recursive: true }); symlinkSync(runtime, join(ctx.app.dataDir, "pdf-loader/2.5.17"), "dir");
  await wd.setWindowRect({ width: 1700, height: 1050 });
  const control = (key: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyUp", value: KEY.control }]);
  const activate = async (selector: string) => { const el = await wd.waitFor(selector, 20000); await wd.execute('arguments[0].focus()', el); await wd.keys([{ type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }]); };
  const click = async (text: string, selector = "button") => {
    if (!await until(async () => { for (const el of await wd.findAll(selector)) if (await wd.displayed(el) && await wd.execute<boolean>('return arguments[0].textContent.trim()===arguments[1]', el, text)) { await wd.click(el); return true; } return false; }, 15000)) throw new Error(`Missing ${text}`);
  };
  const fill = async (selector: string, value: string) => { const el = await wd.waitFor(selector, 20000); await wd.click(el); await control("a"); await wd.sendKeys(el, value); };
  const office = async () => { await wd.frame(null); await wd.frame(await wd.waitFor(`${pane} iframe.office-frame[src*="/pdf.html"]`, 20000)); await wd.waitFor('.pdf-page[data-page="0"]', 30000); };
  const work = await api<Work>("POST", "/api/works", { title: S, cwd: null }), main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const original = readFileSync(new URL("../fixtures/opendataloader/text.pdf", import.meta.url)), scan = readFileSync(new URL("../fixtures/opendataloader/scan-ko.pdf", import.meta.url));
  const source = join(work.cwd, "본문.pdf"), scanned = join(work.cwd, "스캔.pdf"); writeFileSync(source, original); writeFileSync(scanned, scan);
  const textArtifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: source }), scanArtifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: scanned });
  const tabs = [textArtifact, scanArtifact].map((artifact, index) => ({ id: `loader-${index}`, workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } }));
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "loader-pane", panes: [{ ...tabs[0]!, id: "loader-pane", tabs, activeTabId: tabs[0]!.id, recentTabIds: [tabs[0]!.id] }] } });
  await wd.refresh(); await installProbe(wd); await office(); await installProbe(wd);
  phase = "setup and extraction"; await click("추출·OCR", ".ribbon-tab"); await wd.waitFor('[aria-label="PDF 추출·OCR"]');
  if (!await until(() => wd.execute<boolean>('return document.querySelector("[data-pdf-loader-dialog]")?.textContent.includes("한국어/영어 OCR 준비됨")'), 10000)) throw new Error("Installed runtime state missing");
  report.check(S, "원본 엔진·OCR 준비 상태 표시", true, undefined, await shot(ctx, "runtime-ready.png"));
  await fill('[aria-label="추출할 쪽 범위"]', "2"); await click("본문·표·그림 추출", "[data-pdf-loader-dialog] button");
  if (!await until(() => wd.execute<boolean>('return document.querySelector(arguments[0])?.value.includes("Line 1:")', '[aria-label="PDF 추출 미리보기"]'), 30000)) throw new Error("Extraction preview missing");
  report.check(S, "원본 CLI의 지정 쪽·본문·좌표 결과 전달", await wd.execute<boolean>('const t=document.querySelector(arguments[0]).value;return t.includes("[2쪽]")&&!t.includes("[1쪽]")&&t.includes("Line 8:");', '[aria-label="PDF 추출 미리보기"]'));
  await click("Markdown으로 저장·열기", "[data-pdf-loader-dialog] button"); await wd.frame(null);
  const target = join(work.cwd, "추출.md"); await fill('input[aria-label="저장할 파일 경로"]', target); await activate('.office-output-dialog button[type="submit"]');
  if (!await until(async () => existsSync(target), 20000)) throw new Error("Markdown output missing");
  await wd.frame(await wd.waitFor(`${pane} iframe.office-frame[src*="/markdown.html"]`, 20000));
  if (!await until(() => wd.execute<boolean>('return document.body.textContent.includes("Line 8:")'), 15000)) throw new Error("Markdown result editor missing");
  report.check(S, "추출 Markdown 저장·편집기 열기", readFileSync(target, "utf8").includes("Line 8:"));
  phase = "original OCR overlay and search"; await wd.frame(null); await activate(`${pane} [data-tab-id="loader-1"] [role="tab"]`); await office();
  if (!await until(() => wd.execute<boolean>('return [...document.querySelectorAll(".pdf-ocr-layer")].some(el=>el.textContent.includes("OpenDataLoader")&&el.textContent.includes("한글"))'), 180000)) throw new Error("Original OCR overlay missing");
  report.check(S, "한국어·영어 OCR을 원본 선택 가능한 글자층에 연결", true);
  await control("f"); await fill(".pdf-search-input", "OpenDataLoader");
  if (!await until(() => wd.execute<boolean>('return /1/.test(document.querySelector(".pdf-search-count")?.textContent??"")'), 10000)) throw new Error("OCR search missing");
  report.check(S, "스캔 글자 검색·강조 표시", true, undefined, await shot(ctx, "ocr-search.png"));
  report.check(S, "본문·스캔 원문과 기존 판 보존", readFileSync(source).equals(original) && readFileSync(scanned).equals(scan) && (await snapshot()).artifacts.filter(a => [textArtifact.id, scanArtifact.id].includes(a.id)).every(a => a.revision === 1));
  report.check(S, "PDF 도구는 메인 CLI 모델을 호출하지 않음", (await snapshot()).sessions.find(s => s.id === main.id)?.status === "idle");
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return {text:document.body.innerText,html:document.documentElement.outerHTML}').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally { await stage.close(); report.write({ binary, modelCalls: 0, source: "original OpenDataLoader/Docling runtime and original Ieum OCR overlay; synthetic PDFs" }); console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1; }
