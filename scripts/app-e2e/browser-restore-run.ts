import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { openStage } from './launch.ts';
import { until } from './scenarios.ts';
const out = resolve(process.argv[3]!); mkdirSync(out, { recursive: true });
const stage = await openStage(out, { nativeX11: true });
let cookieSeenAfterRestart = false, restarted = false;
const fixture = createServer((req, res) => {
  const signed = req.headers.cookie?.includes('tab-session=retained');
  if (restarted && signed) cookieSeenAfterRestart = true;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Set-Cookie', 'tab-session=retained; Path=/; Max-Age=86400; SameSite=Lax');
  res.end('<!doctype html><title>저장된 연구 자료</title><h1>저장된 연구 자료</h1><p>' + (signed ? '로그인 유지' : '처음 연결') + '</p>');
});
await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${(fixture.address() as any).port}/saved-article`;
const options = { binary: resolve(process.argv[2]!), engines: 'stand-in' as const, profile: 'web-tab-resume', window: { width: 1440, height: 1000 } };
let app: Awaited<ReturnType<typeof stage.launch>> | undefined;
try {
  app = await stage.launch({ ...options, name: 'before-restart' });
  await app.api('PUT', '/api/prefs', { prefs: { onboarding: 'done', theme: 'light' } });
  await app.wd.waitFor('.start-view');
  const work = await app.api<any>('POST', '/api/works', { title: '탭 복원 프로젝트', cwd: null });
  const main = await app.api<any>('POST', `/api/works/${work.id}/sessions`, { provider: 'codex', purpose: '독립 메인 대화' });
  await app.wd.waitFor(`[data-row-id="${work.id}"]`);
  await app.wd.click(await app.wd.waitFor('.pane:not([hidden]) .group-tab-new'));
  await app.wd.waitFor('[role="menuitem"]');
  await app.wd.execute("[...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent.includes('새 웹 탭')).click()");
  await app.wd.waitFor('.browser-blank', 20000);
  await app.wd.sendKeys(await app.wd.waitFor('.browser-blank input[aria-label="웹 검색 또는 주소"]'), url);
  await app.wd.click(await app.wd.waitFor('.browser-blank .browser-search button[type="submit"]'));
  const pages = async () => (await app!.api<any>('GET', '/api/browser/pages')).pages;
  assert(await until(async () => (await pages()).some((p: any) => p.url === url && !p.native?.loading)));
  await app.wd.click(await app.wd.waitFor('.browser-ask'));
  await app.wd.waitFor('.browser-conversation .side-chat-controls select', 20000);
  const original = (await pages()).find((p: any) => p.url === url);
  await app.api('POST', `/api/sessions/${original.sessionId}/messages`, { requestId: 'retained-page-request', text: '재시작 뒤에도 남아야 하는 페이지 대화' });
  assert(await until(async () => (await app!.api<any>('GET', '/api/snapshot')).sessions.find((s: any) => s.id === original.sessionId)?.status === 'idle'));
  const itemsBefore = await app.api<any>('GET', `/api/sessions/${original.sessionId}/items`);
  assert(itemsBefore.items.some((item: any) => item.kind === 'user' && item.text.includes('재시작')));
  assert(await until(async () => JSON.stringify((await app!.api<any>('GET', '/api/layouts/global')).record?.layout).includes(original.pageId)));
  await app.close(); restarted = true;
  app = await stage.launch({ ...options, name: 'after-restart' });
  assert(await until(async () => (await pages()).some((p: any) => p.pageId === original.pageId && p.status === 'ready' && !p.native?.loading), 25000));
  const restored = (await pages()).find((p: any) => p.pageId === original.pageId);
  assert.equal(restored.url, url); assert.equal(restored.profileId, original.profileId); assert.equal(restored.sessionId, original.sessionId);
  assert(cookieSeenAfterRestart, 'persistent browser profile retained its cookie');
  await app.wd.waitFor('.browser-view input[aria-label="현재 웹 주소"]');
  assert.equal(await app.wd.execute("return document.querySelector('.browser-toolbar input').value"), url);
  const itemsAfter = await app.api<any>('GET', `/api/sessions/${original.sessionId}/items`);
  assert.deepEqual(itemsAfter.items, itemsBefore.items);
  await app.wd.screenshot(resolve(out, 'restored-tab.png'));
  // Simulate losing a native view, then close using the actual sidebar X.
  await app.wd.execute(`return window.__TAURI_INTERNALS__.invoke('shared_browser', {command:{kind:'close',pageId:${JSON.stringify(original.pageId)},profileId:${JSON.stringify(original.profileId)}}})`);
  // Keep the page hidden so the restore-on-activation effect does not immediately recreate it.
  await app.wd.execute("[...document.querySelectorAll('.group-tab')].find(el=>el.textContent.includes('홈'))?.click()");
  await app.wd.execute(`const row=document.querySelector('[data-row-id="${work.id}"]'); if(row?.getAttribute('aria-expanded')==='false') row.querySelector('.row-chevron')?.click();`);
  let closeButton = await app.wd.find(`[data-row-id="${original.sessionId}"] .row-web-close`);
  if (!closeButton) {
    await app.wd.click(await app.wd.waitFor(`[data-row-id="${work.id}"]`));
    await app.wd.execute(`const row=document.querySelector('[data-row-id="${work.id}"]'); if(row?.getAttribute('aria-expanded')==='false') row.querySelector('.row-chevron')?.click();`);
  }
  closeButton = await app.wd.waitFor(`[data-row-id="${original.sessionId}"] .row-web-close`);
  await app.wd.screenshot(resolve(out, 'sidebar-close.png'));
  await app.wd.click(closeButton);
  assert(await until(async () => !(await pages()).some((p: any) => p.pageId === original.pageId)));
  const snapshot = await app.api<any>('GET', '/api/snapshot');
  assert(snapshot.sessions.find((s: any) => s.id === original.sessionId).archivedAt);
  assert.equal(snapshot.sessions.find((s: any) => s.id === main.id).archivedAt, null);
  assert(await until(() => app!.wd.execute<boolean>(`return !document.querySelector('[data-row-id="${original.sessionId}"] .row-web-close')`)));
  assert(await until(async () => !JSON.stringify((await app!.api<any>('GET', '/api/layouts/global')).record?.layout).includes(original.pageId)));
  await app.close();
  app = await stage.launch({ ...options, name: 'after-explicit-close' });
  await app.wd.waitFor('.group-tabs');
  assert.equal((await pages()).length, 0);
  assert.deepEqual((await app.api<any>('GET', `/api/sessions/${original.sessionId}/items`)).items, itemsBefore.items);
  const result = { ok: true, platform: 'Linux native WebKitGTK', savedPageId: original.pageId, urlRestored: true, profileCookieRetained: true, childConversationRetained: true, sidebarCloseRemovedTab: true, closedTabStayedClosed: true, mainSessionUnaffected: true };
  writeFileSync(resolve(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  if (app) { await app.wd.screenshot(resolve(out, 'failure.png')).catch(() => {}); writeFileSync(resolve(out, 'failure.txt'), String(error) + '\n' + await app.wd.execute('return document.body.innerText').catch(String)); }
  throw error;
} finally { await stage.close(); await new Promise<void>(done => fixture.close(() => done())); }
