import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY, moveSteps } from "./webdriver.ts";

// Remaining reading-assist boundaries in the original Ieum UI. The model alone is a fixture;
// selection, page image, structure, source text matching, annotations and PDF saves are real.
const require = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument, PDFName } = require("pdf-lib");
const binary = resolve(process.argv[2]!), output = resolve(process.argv[3]!);
mkdirSync(output, { recursive: true });
const report = new Report(output), stage = await openStage(output, { nativeX11: true }), S = "PDF 읽기 결과·핵심 표시·본문 도움";
const sourceLines = ["Research document for reading assistance.", "Evidence supports the original research conclusion.", "The selected passage can be explained in context.", "This final sentence preserves surrounding information."];
const requests: { kind: string; tools: number; prompt: unknown; images: number }[] = [];
const server = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const part of req) raw += String(part);
    const body = JSON.parse(raw), system = body.messages.filter((m: any) => m.role === "system").map((m: any) => String(m.content)).join("\n");
    const prompt = body.messages.filter((m: any) => m.role === "user").at(-1)?.content;
    const kind = system.includes("You transcribe one page") ? "reading" : system.includes("marks the key sentences") ? "highlight" : system.includes("You explain a passage") ? "passage" : "unexpected";
    const images = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "image_url").length;
    requests.push({ kind, tools: body.tools?.length ?? 0, prompt, images });
    let content = "UNEXPECTED_PDF_REQUEST";
    if (kind === "reading") content = `<page-content>\n${sourceLines.join("\n\n")}\n\nREAD_RESULT_SEARCHABLE is the stored reading of this page.\n</page-content>`;
    if (kind === "highlight") {
      const data = JSON.parse(String(prompt).split("<document_blocks>\n")[1]!.split("\n</document_blocks>")[0]!);
      const block = data.blocks.find((b: any) => b.text.includes("Evidence supports"));
      if (!block) throw new Error("Source sentence missing from original highlight request");
      content = JSON.stringify({ highlights: [{ blockId: block.id, label: data.labels[0], quote: "Evidence supports the original research conclusion." }] });
    }
    if (kind === "passage") content = "PASSAGE_HELP_STORED explains the selected sentence using its surrounding text.";
    res.setHeader("content-type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\n`); res.end("data: [DONE]\n\n");
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
let ctx: Ctx | null = null, phase = "start";
try {
  ctx = { stage, app: await stage.launch({ binary, engines: "stand-in", name: "pdf-reading" }), report }; await startScenario(ctx);
  const { wd, api } = ctx.app, snapshot = () => api<Snapshot>("GET", "/api/snapshot"), pane = '.pane[data-tab-active="true"]:not([hidden])';
  const control = (key: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyUp", value: KEY.control }]);
  const activate = async (selector: string) => { const el = await wd.waitFor(selector, 20000); await wd.execute('arguments[0].focus()', el); await wd.keys([{ type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }]); };
  const command = async (name: string) => {
    const selector = `[data-action="${name}"]:not(:disabled)`, el = await wd.waitFor(selector, 20000);
    await wd.execute('arguments[0].scrollIntoView({block:"center"});return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));', el);
    if (await wd.execute<boolean>('return !!arguments[0].closest(".pdf-modal");', el)) await activate(selector); else await wd.click(el);
  };
  const clickText = async (text: string, selector: string) => {
    for (const el of await wd.findAll(selector)) if (await wd.displayed(el) && await wd.execute<boolean>('return arguments[0].textContent.trim()===arguments[1]', el, text)) { await wd.click(el); return; }
    throw new Error(`Missing ${selector}: ${text}`);
  };
  const office = async () => { await wd.frame(null); await wd.frame(await wd.waitFor(`${pane} iframe.office-frame[src*="/pdf.html"]`, 20000)); await wd.waitFor('.pdf-page[data-page="0"]', 30000); };
  const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "pdf-fixture";
  settings.customEndpoints = [{ id: "pdf-fixture", name: "Local PDF fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "pdf-model", kind: "local", modelProfiles: { "pdf-model": { tools: true, toolsSource: "user", vision: true, visionSource: "user", contextLength: 1000000, contextSource: "user" } } }];
  mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
  const work = await api<Work>("POST", "/api/works", { title: S, cwd: null }), main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]);
  sourceLines.forEach((text, i) => page.drawText(text, { x: 40, y: 720 - i * 45, size: 14 }));
  const original = Buffer.from(await pdf.save()), source = join(work.cwd, "읽기 원본.pdf"); writeFileSync(source, original);
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: source });
  const tab = { id: "reading-pdf", workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "reading-pane", panes: [{ ...tab, id: "reading-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd); await office(); await installProbe(wd);
  phase = "AI reading result used by original search";
  await command("ai-read-menu"); await command("ai-read-open");
  await wd.sendKeys(await wd.waitFor(".pdf-ai-read-add input:not(:disabled)"), "1"); await command("add-pages"); await command("next");
  await wd.waitFor('.pdf-ai-read-dialog[data-step="confirm"]'); await command("start"); await wd.waitFor('[data-job-kind="ai-read"][data-job-state="complete"]', 45000);
  await control("f"); const search = await wd.waitFor(".pdf-search-input"); await wd.sendKeys(search, "READ_RESULT_SEARCHABLE");
  const aiPage = await wd.waitFor('.pdf-search-ai-page[data-ai-page="1"]', 15000); await wd.click(aiPage);
  report.check(S, "AI 읽기 결과를 원본 검색에서 찾고 해당 쪽으로 이동", requests.some(r => r.kind === "reading" && r.images > 0), undefined, await shot(ctx, "read-search.png"));
  report.check(S, "읽기/검색만으로 원문 바이트·판을 변경하지 않음", readFileSync(source).equals(original) && (await snapshot()).artifacts.find(a => a.id === artifact.id)?.revision === 1);
  await wd.keys([{ type: "keyDown", value: KEY.escape }, { type: "keyUp", value: KEY.escape }]);
  phase = "AI highlight proposal accepted into saved PDF";
  await command("highlight-open"); await command("next"); await wd.waitFor('.pdf-highlight-dialog[data-step="confirm"]'); await command("start");
  await wd.waitFor('[data-job-kind="highlight"][data-job-state="complete"]', 45000);
  await clickText("보기", ".ribbon-tab"); await clickText("주석", ".ribbon .rb-big");
  await wd.waitFor('[data-action="hl-accept-save"]:not(:disabled)', 45000);
  report.check(S, "원본 문장/좌표의 AI 핵심 표시 제안·수락 전 원문 보존", readFileSync(source).equals(original) && requests.some(r => r.kind === "highlight"), undefined, await shot(ctx, "highlight-proposal.png"));
  await command("hl-accept-save");
  if (!await until(async () => (await snapshot()).artifacts.find(a => a.id === artifact.id)!.revision > 1, 20000)) throw new Error("Accepted highlight did not save");
  const annotationData = async () => {
    const doc = await PDFDocument.load(readFileSync(source));
    return doc.getPages().flatMap((p: any) => (p.node.Annots()?.asArray() ?? []).map((ref: any) => {
      const a = doc.context.lookup(ref), contents = a.get(PDFName.of("Contents"));
      return { subtype: a.get(PDFName.of("Subtype"))?.toString(), contents: contents?.decodeText?.() ?? "", quads: a.get(PDFName.of("QuadPoints"))?.asArray()?.map((v: any) => v.asNumber()) };
    }));
  };
  let annots = await annotationData(); writeFileSync(report.path("accepted-annotations.json"), JSON.stringify(annots, null, 2));
  report.check(S, "수락·저장 시 실제 PDF Highlight 주석과 좌표 생성", annots.some((a: any) => a.subtype === "/Highlight" && a.quads?.length >= 8));
  phase = "selected passage explanation and explicit note save";
  await wd.frame(null); await wd.refresh(); await office(); await installProbe(wd);
  const line = await wd.waitFor('.textLayer span', 15000);
  await wd.execute('const span=[...document.querySelectorAll(".textLayer span")].find(el=>el.textContent.includes("selected passage")); if(!span)throw Error("Selection sentence missing");span.scrollIntoView({block:"center"});', line);
  const bounds = await wd.execute<{ x: number; y: number; right: number }>('const span=[...document.querySelectorAll(".textLayer span")].find(el=>el.textContent.includes("selected passage"));const r=span.getBoundingClientRect();return {x:r.left+2,y:r.top+r.height/2,right:r.right-2};');
  await wd.frame(null); const frame = await wd.waitFor(`${pane} iframe.office-frame[src*="/pdf.html"]`), outer = await wd.rect(frame);
  const from = { x: bounds.x + outer.x, y: bounds.y + outer.y }, to = { x: bounds.right + outer.x, y: bounds.y + outer.y };
  await wd.pointer([{ type: "pointerMove", x: Math.round(from.x), y: Math.round(from.y) }, { type: "pointerDown", button: 0 }, ...moveSteps(from, to, 12), { type: "pointerUp", button: 0 }]);
  await wd.frame(frame); writeFileSync(report.path("selection.json"), JSON.stringify(await wd.execute('return {text:window.getSelection()?.toString(),popup:!!document.querySelector(".pdf-sel-popup")}')));
  await wd.click(await wd.waitFor(".pdf-sel-ask", 15000));
  const chips = await wd.findAll(".ai-ask-chip");
  for (const chip of chips) if (await wd.execute<boolean>('return arguments[0].textContent.includes("설명")', chip)) { await wd.click(chip); break; }
  if (!await until(() => wd.execute<boolean>('return document.querySelector("[data-passage-answer]")?.textContent.includes("PASSAGE_HELP_STORED")'), 30000)) throw new Error("Original passage explanation missing");
  const beforeNote = readFileSync(source), beforeRevision = (await snapshot()).artifacts.find(a => a.id === artifact.id)!.revision;
  const passage = requests.find(r => r.kind === "passage");
  report.check(S, "선택 구절·앞뒤 문맥을 독립 AI 도움 카드로 전달", !!passage && String(passage.prompt).includes("selected passage") && String(passage.prompt).includes("surrounding information") && passage.tools === 0, undefined, await shot(ctx, "passage-card.png"));
  await activate('.pdf-passage-card [data-action="note"]'); await wd.waitFor('[data-note-state="pending"]');
  report.check(S, "본문 도움의 노트 추가는 명시 저장 전 원문을 유지", readFileSync(source).equals(beforeNote));
  await control("s");
  if (!await until(async () => (await snapshot()).artifacts.find(a => a.id === artifact.id)!.revision > beforeRevision, 20000)) throw new Error("Passage note did not save");
  annots = await annotationData(); writeFileSync(report.path("saved-annotations.json"), JSON.stringify(annots, null, 2));
  report.check(S, "명시 저장한 PDF에 핵심 표시와 AI 도움 노트를 함께 보존", annots.some((a: any) => a.subtype === "/Highlight") && annots.some((a: any) => a.contents.includes("PASSAGE_HELP_STORED")));
  await wd.frame(null); await wd.refresh(); await office();
  report.check(S, "저장 후 다시 열기·메인 CLI 분리·추가 모델 호출 없음", requests.length === 3 && requests.every(r => r.tools === 0) && (await snapshot()).sessions.find(s => s.id === main.id)?.status === "idle" && !(await pageErrors(wd)).length, undefined, await shot(ctx, "saved-reopened.png"));
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return {text:document.body.innerText,html:document.documentElement.outerHTML}').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  writeFileSync(report.path("model-requests.json"), JSON.stringify(requests, null, 2));
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await stage.close(); report.write({ binary, source: "original Ieum PDF reading UI and document engine; synthetic PDF and local model fixture" }); console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1;
}
