import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { hwpScenario } from "./hwp.ts";
import { startScenario, pageErrors, shot, until, type Ctx } from "./scenarios.ts";

// Actual Ieum HWP/HWPX save/reopen, with HOP's engine and host font/canvas additions.
// Uses the existing native scenario; no model request or simulated document editor.
const binary = resolve(process.argv[2]!), output = resolve(process.argv[3]!);
mkdirSync(output, { recursive: true });
const report = new Report(output), stage = await openStage(output, { nativeX11: true, printDialog: true });
let ctx: Ctx | null = null;
try {
  ctx = { stage, app: await stage.launch({ binary, engines: "stand-in", name: "hop" }), report };
  await startScenario(ctx); await hwpScenario(ctx);
  const { wd } = ctx.app;
  await wd.frame(null); await wd.frame(await wd.waitFor('.pane:not([hidden]) iframe.office-frame', 30000));
  await wd.waitFor('.hwp-app[data-phase="ready"]', 60000);
  await wd.frame(await wd.waitFor('.hwp-editor-host iframe', 30000));
  const ready = await until(() => wd.execute<boolean>('const s=window.rhwpStudio?.fonts.getState();return !!s?.active && s.count>0 && !s.lastError;'), 30000);
  const fonts = await wd.execute('return {host:window.rhwpStudio?.fonts.getState(),faces:Array.from(document.fonts).map(f=>({family:f.family,status:f.status}))};');
  writeFileSync(report.path("fonts.json"), JSON.stringify(fonts, null, 2));
  report.check("HOP 개선", "실제 설치 글꼴을 원본 studio 공급자로 연결", ready, JSON.stringify(fonts).slice(0, 1200));
  await wd.execute('window.__hopDrawFonts=new Set();const p=CanvasRenderingContext2D.prototype;for(const name of ["fillText","strokeText"]){const draw=p[name];p[name]=function(...args){window.__hopDrawFonts.add(this.font);return draw.apply(this,args);}}');
  for (const command of ["view:zoom-100", "view:zoom-in", "view:zoom-out"]) {
    await wd.execute('return window.rhwpStudio.automation.execute(arguments[0]);', command);
    const snapped = await until(() => wd.execute<boolean>('const c=document.querySelector(".document-page-canvas"),d=devicePixelRatio||1;return !!c && c.style.imageRendering==="pixelated" && Math.abs(parseFloat(c.style.width)*d-c.width)<0.01 && Math.abs(parseFloat(c.style.height)*d-c.height)<0.01;'), 15000);
    const grid = await wd.execute('return Array.from(document.querySelectorAll("#scroll-content canvas")).map(c=>({width:c.width,height:c.height,cssWidth:c.style.width,cssHeight:c.style.height,translate:c.style.translate,filter:c.style.imageRendering,dpr:devicePixelRatio}));');
    writeFileSync(report.path(`${command.replace(":", "-")}.json`), JSON.stringify(grid, null, 2));
    report.check("HOP 개선", `${command}에서 실제 쪽 canvas 픽셀 정렬`, snapped, undefined, await shot(ctx, `${command.replace(":", "-")}.png`));
  }
  const drawFonts = await wd.execute<string[]>('return [...window.__hopDrawFonts];');
  writeFileSync(report.path("canvas-fonts.json"), JSON.stringify(drawFonts, null, 2));
  report.check("HOP 개선", "실제 Canvas 본문 그리기에 문서의 설치 글꼴 사용", drawFonts.some(font => font.includes("함초롬바탕")), JSON.stringify(drawFonts));
  report.check("HOP 개선", "한글 재열기·글꼴·배율 변경 후 페이지 예외 없음", !(await pageErrors(wd)).length);
} catch (error) {
  report.check("HOP 개선", "native scenario", false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ error: String(error), page: await ctx.app.wd.execute('return {text:document.body.innerText,html:document.documentElement.outerHTML}').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  await stage.close(); report.write({ binary, source: "Ieum original HWP studio with selected HOP patches and installed system fonts" }); console.log(report.summary()); if (report.steps.some(s => !s.ok)) process.exitCode = 1;
}
