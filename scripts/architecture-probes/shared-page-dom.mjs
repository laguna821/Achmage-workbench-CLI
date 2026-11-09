// Runs the exact native-page DOM adapter against an isolated local fixture. This is not a Tauri/OS UI test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const executablePath = process.env.WORKBENCH_TEST_CHROMIUM;
if (!executablePath) throw Error('Set WORKBENCH_TEST_CHROMIUM to an existing test Chromium executable.');
const script = await readFile(new URL('../../apps/desktop/src-tauri/src/shared_browser.js', import.meta.url), 'utf8');
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>Shared page fixture</title><h1>한글 웹 페이지</h1><button id="count" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><input aria-label="본문"><a href="/next">다음</a>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext(); await context.addInitScript({ content: script });
  const url = `http://127.0.0.1:${server.address().port}`;
  const a = await context.newPage(), b = await context.newPage();
  await Promise.all([a.goto(url), b.goto(url)]);
  const call = (page, action, control, nonce = null) => page.evaluate(({ action, control, nonce }) => window.__ACHMAGE_PAGE__.run(action, control, nonce), { action, control, nonce });
  const human = { generation: 0, owner: 'human' }, agent = { generation: 1, owner: 'page-child' };
  const one = await call(a, { kind: 'snapshot' }, human), two = await call(b, { kind: 'snapshot' }, human);
  assert.notEqual(one.documentNonce, two.documentNonce);
  const ref = one.text.match(/\[(e\d+)\] button 0/)[1];
  await call(a, { kind: 'control', control: agent }, agent);
  await b.bringToFront();
  assert.equal((await call(a, { kind: 'click', ref }, agent, one.documentNonce)).error, undefined);
  assert.equal(await a.locator('#count').textContent(), '1');
  assert.equal(await b.locator('#count').textContent(), '0');
  assert.equal((await call(a, { kind: 'snapshot' }, agent)).documentNonce, one.documentNonce);
  await a.locator('#count').click(); // actual trusted pointer event immediately takes control
  const late = await call(a, { kind: 'click', ref }, agent, one.documentNonce);
  assert.equal(late.error, 'CONTROL_REVOKED'); assert.equal(await a.locator('#count').textContent(), '2');
  const person = await a.evaluate(() => window.__ACHMAGE_PAGE__.state({ generation: 1, owner: 'page-child' }));
  assert.equal(person.control.owner, 'human'); assert.ok(person.interactionAt > 0);
  await a.goto(`${url}/next`);
  assert.equal((await call(a, { kind: 'click', ref }, person.control, one.documentNonce)).error, 'STALE_DOCUMENT');
  assert.equal(await a.locator('#count').textContent(), '0');
  const fresh = await call(a, { kind: 'snapshot' }, person.control);
  assert.notEqual(fresh.documentNonce, one.documentNonce);
  await a.locator('#count').evaluate(el => { const replacement = el.cloneNode(true); el.replaceWith(replacement); });
  assert.match((await call(a, { kind: 'click', ref }, person.control, fresh.documentNonce)).error, /STALE_ELEMENT/);
  console.log(JSON.stringify({ sameUrlDifferentPage: true, hiddenTargetRetained: true, trustedHumanFencesLateClick: true, navigationRejectsOldDocument: true, replacedElementNotRebound: true, scope: 'exact DOM adapter in Chromium fixture; native Tauri OS integration not asserted' }));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
