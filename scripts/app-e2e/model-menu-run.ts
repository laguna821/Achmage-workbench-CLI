import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { openStage } from "./launch.ts";
import { until } from "./scenarios.ts";

const out = resolve(process.argv[3]!); mkdirSync(out, { recursive: true });
const stage = await openStage(out, { nativeX11: true });
const fixture = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end('<!doctype html><title>모델 선택 중에도 유지되는 웹 페이지</title><style>body{background:#dbeeff;color:#173d62;font:24px sans-serif;padding:40px}h1{font-size:30px}</style><h1>모델 선택 중에도 웹 페이지 유지</h1><p>오른쪽 메뉴에서 모델과 추론 강도를 선택합니다.</p>');
});
await new Promise<void>(done => fixture.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(fixture.address() as any).port}/`;
let app: Awaited<ReturnType<typeof stage.launch>> | undefined;
try {
  app = await stage.launch({ binary: resolve(process.argv[2]!), engines: "stand-in", name: "model-menu", window: { width: 1440, height: 1000 } });
  const { api, wd } = app;
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", theme: "light" } });
  await wd.waitFor(".start-view");
  const work = await api<any>("POST", "/api/works", { title: "모델 메뉴 확인", cwd: null });
  await api("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "메인 대화" });
  await wd.waitFor(`[data-row-id="${work.id}"]`);
  await wd.click(await wd.waitFor(".pane:not([hidden]) .group-tab-new"));
  await wd.waitFor('[role="menuitem"]');
  await wd.execute("[...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent.includes('새 웹 탭')).click()");
  await wd.waitFor(".browser-blank", 20000);
  await wd.sendKeys(await wd.waitFor('.browser-blank input[aria-label="웹 검색 또는 주소"]'), url);
  await wd.click(await wd.waitFor('.browser-blank button[type="submit"]'));
  const pages = async () => (await api<any>("GET", "/api/browser/pages")).pages;
  assert(await until(async () => (await pages()).some((p: any) => p.url === url && !p.native?.loading)));
  await wd.click(await wd.waitFor(".browser-ask"));
  await wd.waitFor(".browser-conversation .side-chat-controls select", 20000);
  const page = (await pages()).find((p: any) => p.url === url);
  const nativeVisible = async () => {
    const point = await wd.execute<{x:number;y:number}>("const r=document.querySelector('.browser-viewport').getBoundingClientRect();return {x:Math.round(r.right-30),y:Math.round(r.top+r.height/2)}");
    const path = resolve(out, "native-screen.png");
    await app!.command("/usr/bin/import", ["-window", "root", path]);
    const result = await app!.command("/usr/bin/python3", ["-c", "from PIL import Image; import sys,json; print(json.dumps(Image.open(sys.argv[1]).convert('RGB').getpixel((int(sys.argv[2]),int(sys.argv[3])))))", path, String(point.x), String(point.y)]);
    return JSON.stringify(JSON.parse(result.stdout)) === JSON.stringify([219,238,255]);
  };
  assert(await until(nativeVisible));
  const measurements: any[] = [];
  const checkPopup = async (label: string) => {
    await wd.waitFor(".browser-conversation .popover");
    assert(await until(() => wd.execute<boolean>("return document.querySelector('.browser-conversation .popover').getAnimations().every(a=>a.playState==='finished')")));
    const geometry = await wd.execute<any>(`const menu=document.querySelector('.browser-conversation .popover'), panel=document.querySelector('.browser-conversation'), input=document.querySelector('.model-custom-form input'),m=menu.getBoundingClientRect(),p=panel.getBoundingClientRect();return {menu:{left:m.left,right:m.right,top:m.top,bottom:m.bottom,width:m.width,height:m.height},panel:{left:p.left,right:p.right,top:p.top,bottom:p.bottom,width:p.width},scrollWidth:menu.scrollWidth,clientWidth:menu.clientWidth,formWidth:input?.getBoundingClientRect().width??null};`);
    const { menu: m, panel: p } = geometry;
    assert(m.width > 180 && m.height > 60, label);
    assert(m.left >= p.left && m.right <= p.right && m.top >= p.top && m.bottom <= p.bottom, label + ": not clipped");
    assert(geometry.scrollWidth <= geometry.clientWidth + 1, label + ": no horizontal overflow");
    assert(await nativeVisible(), label + ": native web view remains presented");
    measurements.push({ label, ...geometry });
    await wd.screenshot(resolve(out, label + ".png"));
  };
  await wd.click(await wd.waitFor(".side-chat-controls .plain-select"));
  await checkPopup("model-regular");
  // Resize while the popup is open: the same menu must follow the new clipping bounds.
  await wd.setWindowRect({ width: 1024, height: 720 });
  await checkPopup("model-narrow");
  const chosen = await wd.execute<string>("const items=[...document.querySelectorAll('.model-menu [role=menuitemcheckbox]')];const target=items.at(-1);target.click();return target.querySelector('.menu-item-label').textContent");
  assert(await until(() => wd.execute<boolean>(`return document.querySelector('.side-chat-controls .plain-select').textContent.includes(${JSON.stringify(chosen)})`)));
  const afterSelection = (await api<any>("GET", "/api/snapshot")).sessions.find((s: any) => s.id === page.sessionId);
  assert(afterSelection.model, "model is saved on this child");
  const effort = await wd.find('.side-chat-controls button[title="추론 강도"]');
  if (effort) {
    await wd.click(effort); await checkPopup("effort-narrow");
    await wd.execute("document.querySelector('.side-chat-controls .popover [role=menuitemcheckbox]:last-child').click()");
  }
  await wd.click(await wd.waitFor(".side-chat-controls .plain-select"));
  await wd.waitFor(".model-menu");
  await wd.execute("[...document.querySelectorAll('.model-menu [role=menuitem]')].find(el=>el.textContent.includes('모델 ID 직접 입력')).click()");
  await checkPopup("custom-narrow");
  await wd.execute("document.querySelector('.model-custom-form input').value=''");
  await wd.sendKeys(await wd.waitFor(".model-custom-form input"), "fixture-menu-selection");
  await wd.click(await wd.waitFor('.model-custom-form button[type="submit"]'));
  assert(await until(async () => (await api<any>("GET", "/api/snapshot")).sessions.find((s: any) => s.id === page.sessionId).model === "fixture-menu-selection"));
  const result = { ok: true, platform: "Linux native WebKitGTK", engines: "stand-in; no AI turn", nativePageVisibleWithMenus: true, modelSaved: true, customModelSaved: true, measurements };
  writeFileSync(resolve(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  if (app) { await app.wd.screenshot(resolve(out, "failure.png")).catch(() => {}); writeFileSync(resolve(out, "failure.txt"), String(error) + "\n" + await app.wd.execute("return document.body.innerText").catch(String)); }
  throw error;
} finally { await stage.close(); await new Promise<void>(done => fixture.close(() => done())); }
