import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Artifact, Snapshot, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { fixture } from "./office-suite.ts";
import { KEY } from "./webdriver.ts";

const binary = resolve(process.argv[2]!), outDir = resolve(process.argv[3]!);
const legacyApp = process.env.APP_E2E_IEUM_BIN;
process.env.XDG_CURRENT_DESKTOP = "GNOME";
mkdirSync(outDir, { recursive: true });
const report = new Report(outDir), stage = await openStage(outDir, { privateKeyring: true, nativeX11: true });
const S = "이음 설정 가져오기", source = join(outDir, "original-ieum"), key = "synthetic-import-only-key", name = "이음에서 가져온 스타일";
mkdirSync(join(source, "style-templates"), { recursive: true });
const styles = { name, topic: "원본 발표", styleSkill: "원본 스타일 본문\nKeep the original layout.", createdAt: "2026-11-01", basedOn: "clean", layout: { future: "preserve" } };
writeFileSync(join(source, "style-templates/style.json"), JSON.stringify(styles));
let receivedImportedKey = false;
const server = createServer((req, res) => { if (req.headers.authorization === `Bearer ${key}`) receivedImportedKey = true; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "import-model" }] })); });
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
writeFileSync(join(source, "ai-settings.json"), JSON.stringify({ providers: {}, provider: "custom", customEndpoint: "import-local", subscriptionNoticeSeen: true,
  customEndpoints: [{ id: "import-local", name: "가져온 로컬 모델", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key, model: "import-model", kind: "local" }] }));
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const originals = [join(source, "ai-settings.json"), join(source, "style-templates/style.json")].map(file => ({ file, sha256: digest(file) }));
let ctx: Ctx | null = null, phase = "start";
try {
  const launch = { binary, engines: "stand-in" as const, profile: "office-import" };
  ctx = { stage, app: await stage.launch({ ...launch, name: "import" }), report }; await startScenario(ctx);
  let wd = ctx.app.wd;
  const api = <T>(method: string, path: string, body?: unknown) => ctx!.app.api<T>(method, path, body);
  const clickText = async (text: string) => { const button = await wd.execute<any>('return [...document.querySelectorAll("button")].find(e=>e.textContent.trim()===arguments[0]);', text); if (!button) throw new Error(`Missing button: ${text}`); await wd.click(button); };
  const openImport = async () => { await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]')); await clickText("이음오피스 설정 가져오기…"); await wd.waitFor(".office-import-dialog"); await installProbe(wd); };
  phase = "preview"; await openImport();
  const input = await wd.waitFor('.office-import-dialog input:not([type="checkbox"])'); await wd.click(input);
  await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]);
  await wd.sendKeys(input, source); await clickText("가져올 항목 확인");
  await wd.waitFor(".office-import-preview");
  report.check(S, "가져오기 전 설정·키 개수와 저장 스타일을 표시", await wd.execute<boolean>('return document.querySelector(".office-import-preview").innerText.includes(arguments[0]) && !document.querySelector(".office-import-dialog").innerText.includes(arguments[1]);', name, key), undefined, await shot(ctx, "import-preview.png"));
  phase = "apply"; await clickText("선택한 항목 가져오기");
  if (!await until(() => wd.execute<boolean>('return document.querySelector(".office-import-dialog")?.innerText.includes("스타일 1개 추가");'), 30000)) throw new Error("Import did not finish");
  const settingsPath = join(ctx.app.dataDir, "office/ai-settings.json"), imported = readFileSync(settingsPath, "utf8");
  report.check(S, "키를 실제 OS 저장소로 봉인하고 설정·스타일 가져오기", imported.includes("sealed:v1:workbench:") && !imported.includes(key) && readdirSync(join(ctx.app.dataDir, "office-styles/styles")).length === 1, undefined, await shot(ctx, "import-done.png"));
  report.check(S, "원본 설정·스타일 바이트 보존", originals.every(item => digest(item.file) === item.sha256));
  await clickText("완료");
  await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]')); await clickText("문서 AI 설정…"); await wd.frame(await wd.waitFor('iframe[title="문서 AI 설정 화면"]')); await installProbe(wd);
  report.check(S, "원본 AI 설정 화면에서 가져온 모델 확인", await until(() => wd.execute<boolean>('return document.body.innerText.includes("가져온 로컬 모델");'), 15000), undefined, await shot(ctx, "import-ai-settings.png"));
  await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="문서 AI 설정 닫기"]'));
  phase = "saved style in original gallery";
  const work = await api<Work>("POST", "/api/works", { title: S, cwd: null }), path = join(work.cwd, "가져온 스타일.pptx"); await fixture(path, "pptx");
  const doc = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path });
  const tab = { id: "import-doc", workId: work.id, sessionId: null, view: { kind: "document", artifactId: doc.id, proposalId: null }, ui: { mode: "edit" } };
  await seedLayout(ctx, { ...(await api<Snapshot>("GET", "/api/snapshot")).prefs, paneLayout: { version: 2, focus: "import-pane", panes: [{ ...tab, id: "import-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.refresh(); await wd.frame(await wd.waitFor('iframe.office-frame', 30000)); await installProbe(wd); await wd.click(await wd.waitFor(".ai-tpl-chip-main", 30000)); await wd.waitFor(".ai-tpl-card-saved", 20000);
  const card = await wd.execute<any>('return [...document.querySelectorAll(".ai-tpl-card-saved")].find(e=>e.innerText.includes(arguments[0]));', name); if (!card) throw new Error("Imported style absent from original gallery");
  await wd.execute('arguments[0].scrollIntoView({block:"center"});', card); await wd.click(card);
  const selection = await wd.execute<any>('return window.slidesApi.getTemplateSelection();'), loaded = await wd.execute<any>('return window.slidesApi.loadStyleTemplate(arguments[0]);', name);
  report.check(S, "원본 PPT 갤러리에서 가져온 스타일 선택·본문·배치 보존", selection?.key === name && loaded.styleSkill === styles.styleSkill && loaded.layout?.future === "preserve", undefined, await shot(ctx, "import-gallery.png"));
  phase = "restart"; await ctx.app.close(); ctx.app = await stage.launch({ ...launch, name: "import-restarted" }); wd = ctx.app.wd;
  await wd.frame(await wd.waitFor('iframe.office-frame', 30000)); await wd.waitFor(".ai-tpl-chip-main", 30000); await installProbe(wd);
  report.check(S, "재시작 후 가져온 설정과 스타일 선택 유지", readFileSync(settingsPath, "utf8") === imported && (await wd.execute<any>('return window.slidesApi.getTemplateSelection();'))?.key === name);
  const preview = await api<any>("POST", "/api/office-import/preview", { directory: source });
  const repeat = await api<any>("POST", "/api/office-import/apply", { id: preview.id, ai: false, keys: false, styles: true });
  report.check(S, "다시 가져와도 같은 스타일 중복 없음", preview.ai.replacesCurrent && repeat.skipped === 1 && repeat.styles === 0 && readdirSync(join(ctx.app.dataDir, "office-styles/styles")).length === 1);
  if (legacyApp) {
    phase = "official app legacy encryption and reveal";
    const seeded = JSON.parse((await ctx.app.command(process.execPath, [resolve("scripts/fixtures/ieum-legacy-seed.mjs"), legacyApp, join(source, "ai-settings.json")])).stdout.trim());
    await api("POST", "/api/tools/ieumoffice/link", { path: legacyApp });
    const legacyFile = join(seeded.directory, "ai-settings.json"), before = digest(legacyFile);
    const legacy = await api<any>("POST", "/api/office-import/preview", { directory: seeded.directory });
    const importedLegacy = await api<any>("POST", "/api/office-import/apply", { id: legacy.id, ai: true, keys: true, styles: false });
    report.check(S, "공식 이음 앱의 실제 safeStorage 키를 읽어 Workbench로 재봉인", seeded.sealed && legacy.ai.sealedKeys > 0 && importedLegacy.ai && readFileSync(settingsPath, "utf8").includes("sealed:v1:workbench:") && digest(legacyFile) === before);
    receivedImportedKey = false;
    const current = await api<any>("GET", "/api/office-ai/settings");
    await api("POST", "/api/office-ai/invoke", { channel: "ai:custom-models", args: [current.settings.customEndpoints[0]], owner: "import-fixture" });
    report.check(S, "재봉인한 키가 로컬 시험 서버에서 원래 키와 일치", receivedImportedKey && !readFileSync(settingsPath, "utf8").includes(key));
  }
  report.check(S, "화면 예외 없음", (await pageErrors(wd)).length === 0);
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return document.body.innerText').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await stage.close();
  report.write({ binary, key: "synthetic input, actual OS vault output", originalLegacyApp: legacyApp ?? "not exercised in this UI run", sourcesUnchanged: originals.every(item => digest(item.file) === item.sha256) }); console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1;
}
