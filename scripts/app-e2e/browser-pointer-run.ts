// Linux GTK pointer routing regression. Private Broadway display, no model turn.
// node scripts/app-e2e/browser-pointer-run.ts <built-app> <evidence-dir>
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserList, BrowserJobResult, Session, Snapshot, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { until, type Ctx } from "./scenarios.ts";


const binary = resolve(process.argv[2]!), output = resolve(process.argv[3]!);
mkdirSync(output, { recursive: true });
const report = new Report(output), stage = await openStage(output);
const fixture = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url === "/frame" ? '<title>Subframe</title>iframe' : '<!doctype html><title>Browser input fixture</title><style>body{font:20px sans-serif;padding:32px;background:#f0faf8}input{font:inherit;width:80%;padding:16px}</style><h1>같은 페이지 입력 확인</h1><input aria-label="검색" placeholder="검색어"><iframe src="/frame" style="width:100px;height:40px"></iframe>');
});
await new Promise<void>(done => fixture.listen(0, "127.0.0.1", done));
const address = `http://127.0.0.1:${(fixture.address() as {port:number}).port}/`;
let ctx: Ctx | null = null;
try {
  ctx = { stage, report, app: await stage.launch({ binary, engines: "stand-in", name: "browser-hotfix", window: { width: 1440, height: 1000 } }) };
  const { api, wd } = ctx.app;
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const pages = () => api<BrowserList>("GET", "/api/browser/pages");
  await wd.click(await wd.waitFor(".onboarding-actions button", 30_000));
  assert(await until(async () => (await snapshot()).prefs.onboarding === "done"));

  const work = await api<Work>("POST", "/api/works", { title: "브라우저 입력 확인", cwd: null });
  const main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", model: "gpt-6.1-sol", access: "full", purpose: "브라우저 확인 메인" });
  await wd.waitFor(`[data-row-id="${work.id}"]`);
  if (!await wd.find(`[data-row-id="${main.id}"]`)) await wd.click(await wd.waitFor(`[data-row-id="${work.id}"] .row-chevron`));
  await wd.click(await wd.waitFor(`[data-row-id="${main.id}"]`));
  await wd.waitFor('.work-view .composer textarea');
  const before = await wd.execute<number[]>("return [innerWidth, innerHeight]");
  await wd.click(await wd.waitFor('.pane:not([hidden]) .group-tab-new'));
  await wd.waitFor('[role="menuitem"]');
  await wd.execute("[...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent.includes('새 웹 탭')).click()");
  await wd.waitFor(".browser-blank", 20_000);
  assert(await wd.find('[role="tab"][aria-selected="true"]'));
  report.check("native browser", "빈 탭에 중앙 Search/Ask, 별도 설정 모달 없음", !await wd.find(".browser-create-dialog"), "", await wd.screenshot(report.path("blank.png")));
  await wd.sendKeys(await wd.waitFor('.browser-blank input[aria-label="웹 검색 또는 주소"]'), address);
  await wd.click(await wd.waitFor('.browser-blank .browser-search button[type="submit"]'));
  assert(await until(async () => (await pages()).pages.some(page => page.url === address && !page.native?.loading), 20_000));
  let page = (await pages()).pages.find(page => page.url === address)!;
  const after = await wd.execute<number[]>("return [innerWidth, innerHeight]");
  assert.deepEqual(after, before, "Native page must not divide the main webview vertically");
  assert(!await wd.find(".browser-conversation"), "Panel starts collapsed");
  await wd.execute("[...document.querySelectorAll('.browser-toolbar button')].find(el=>el.textContent==='AI에게 요청').click()");
  await wd.waitFor('.browser-conversation textarea', 20_000);
  page = (await pages()).pages.find(p => p.pageId === page.pageId)!;
  assert(page.sessionId, "Page has an independent child");
  const child = (await snapshot()).sessions.find(row => row.id === page.sessionId)!;
  assert.equal(child.pageAgent?.parentSessionId, main.id);
  const geometry = await wd.execute<any>(`const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}};return {viewport:box('.browser-viewport'),chat:box('.browser-conversation'),composer:box('.browser-conversation .composer'),inner:[innerWidth,innerHeight]}`);
  assert(Math.abs(geometry.viewport.height - geometry.chat.height) < 2);
  assert(geometry.composer.bottom <= geometry.chat.bottom + 1);
  report.check("native browser", "웹 영역과 전체 높이 우측 채팅, main viewport 유지", true, JSON.stringify(geometry));
  const display = await chromium.launch();
  try {
    const canvas = await display.newPage({ viewport: { width: 1800, height: 1400 } });
    await canvas.goto('http://127.0.0.1:' + stage.broadwayPort);
    await canvas.waitForFunction(() => (document.querySelector('canvas')?.width ?? 0) > 0);
    await canvas.waitForTimeout(1200);
    const surface = await canvas.locator('canvas').first().elementHandle();
    assert(surface);
    const nativeSurface = await surface.boundingBox();
    assert(nativeSurface);
    // Fixture screenshot establishes GTK content inset (25,60); click inside
    // its actual search field through the Broadway display, not a DOM fill.
    await canvas.mouse.click(nativeSurface.x + 25 + geometry.viewport.x + 140, nativeSurface.y + 60 + geometry.viewport.y + 190);
    // Broadway forwards focus asynchronously over its display connection.
    await canvas.waitForTimeout(300);
    await canvas.keyboard.type('manual input', {delay:40});
    await canvas.waitForTimeout(1000);
    await surface.screenshot({path:report.path('after-pointer.png')});
    const manual = await api<BrowserJobResult>('POST', '/api/browser/pages/' + page.pageId + '/action', {requestId:randomUUID(), action:{kind:'snapshot'}});
    writeFileSync(report.path('manual-input.json'),JSON.stringify(manual,null,2));
    const sidebarBefore=await wd.execute("return Boolean(document.querySelector('.body.with-sidebar'))");
    await canvas.mouse.click(nativeSurface.x+60,nativeSurface.y+84);
    await canvas.waitForTimeout(500);
    const sidebarAfter=await wd.execute("return Boolean(document.querySelector('.body.with-sidebar'))");
    writeFileSync(report.path('pointer-diagnostic.json'),JSON.stringify({nativeSurface,geometry,sidebarBefore,sidebarAfter,manual:manual.observation?.text},null,2));
    assert(manual.observation?.text.includes('value="manual input"'), 'Native pointer/keyboard input did not reach the displayed page');
    report.check('native browser','실제 네이티브 화면에서 마우스·키보드 직접 입력',true);
    assert(sidebarBefore !== sidebarAfter, 'Native positioning layer swallowed the app sidebar click');
    report.check('native browser','웹 페이지 밖 앱 메뉴의 실제 마우스 입력',true);
    await surface.screenshot({path: report.path('native-composite.png')});
    writeFileSync(report.path('display-dom.txt'), await canvas.locator('body').innerHTML());
  } finally { await display.close(); }
} catch (error) {
  report.check("native browser", "실제 앱 흐름", false, error instanceof Error ? error.stack ?? error.message : String(error));
  if (ctx) {
    writeFileSync(report.path("failure-dom.txt"), await ctx.app.wd.execute<string>("return document.body.innerText").catch(String));
    await ctx.app.wd.screenshot(report.path("failure.png")).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  report.write({ scope: "Actual GTK native page and main-chrome pointer/keyboard input through Broadway; seeded test provider, no model turn submitted" });
  await ctx?.app.close(); await stage.close();
  await new Promise<void>(done => fixture.close(() => done()));
}
