import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, Snapshot, Work } from "@workbench/contracts";
import { epubFixture, epubEntry, EPUB_SECOND } from "./epub-fixture.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

export async function epubOfficeScenario(ctx: Ctx) {
  const S = "29 EPUB 원본 편집기", { wd, api } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "전자책 이음 편집 검사", cwd: null });
  const file = join(work.cwd, "원문 보존 전자책.epub"), original = await epubFixture(); writeFileSync(file, original);
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const tab = { id: "epub-tab", workId: work.id, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "epub-pane", panes: [{ ...tab, id: "epub-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
  const office = async () => { await wd.frame(null); await wd.frame(await wd.waitFor("iframe.office-frame", 30000)); await wd.waitFor("iframe.epub-frame", 30000); };
  const chapter = async (selector = "#p1") => { await office(); await wd.frame(await wd.waitFor("iframe.epub-frame")); await wd.waitFor(selector, 15000); };
  const shortcut = (value: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value }, { type: "keyUp", value }, { type: "keyUp", value: KEY.control }]);
  const edit = async (text: string) => {
    await chapter(); const field = await wd.waitFor('#p1[contenteditable="true"]');
    await wd.click(field); await shortcut("a"); await wd.press("\uE003"); await wd.sendKeys(field, text);
    await office();
    writeFileSync(ctx.report.path("29-epub-input.json"), JSON.stringify(await wd.execute('const doc=document.querySelector("iframe.epub-frame").contentDocument;return {events:window.__epubEvents,calls:window.__epubCalls,html:doc.body.innerHTML,errors:window.__appErrors};'), null, 2));
  };
  const save = async () => {
    await office();
    await wd.execute('window.__epubSaveDone=false; const api=window.epubApi; if(!api.__observedSave){const save=api.save;api.save=async(...args)=>{try{return await save(...args);}finally{window.__epubSaveDone=true;}};api.__observedSave=true;}');
    await wd.click(await wd.waitFor('[data-action="quick-save"]'));
    if (!await until(async () => wd.execute<boolean>("return window.__epubSaveDone===true"), 20000)) throw new Error("EPUB save did not settle");
  };
  const content = async () => (await epubEntry(readFileSync(file), "OEBPS/text/one.xhtml"))!.toString();
  const clickText = async (selector: string, label: string) => {
    if (!await until(async () => { for (const button of await wd.findAll(selector)) if ((await wd.execute<string>("return arguments[0].textContent.trim()", button)) === label && await wd.displayed(button)) { await wd.click(button); return true; } return false; }, 15000)) throw new Error(`Missing EPUB command: ${label}`);
  };
  await office(); await installProbe(wd);
  await wd.execute('window.__epubEvents=[];window.__epubCalls=[];const frame=document.querySelector("iframe.epub-frame");for(const type of ["keydown","beforeinput","input","compositionstart","compositionend"]){frame.contentDocument.addEventListener(type,e=>window.__epubEvents.push({type:e.type,inputType:e.inputType,target:e.target?.outerHTML?.slice(0,300),trusted:e.isTrusted}),true);}for(const name of ["applyEdits","replaceRanges"]){const original=window.epubApi[name];window.epubApi[name]=async(...args)=>{const result=await original(...args);window.__epubCalls.push({name,args,result});return result;};}');
  ctx.report.check(S, "원본 전자책 화면을 Electron 없이 열기", await wd.execute<boolean>('return !!window.epubApi && !!document.querySelector(".epub-app");'), undefined, await shot(ctx, "29-epub-open.png"));
  ctx.report.check(S, "WebKit 장 프레임에 부모 입력 이벤트 호환 적용", await wd.attribute(await wd.waitFor("iframe.epub-frame"), "sandbox") === "allow-same-origin allow-scripts");
  await chapter();
  ctx.report.check(S, "책 안 그림·CSS 표시와 외부 자산·스크립트 차단", await until(async () => wd.execute<boolean>('const img=document.querySelector("img[alt]");return img?.naturalWidth>0 && getComputedStyle(document.body).color==="rgb(23, 57, 85)" && !window.__epubIntrusion && !document.querySelector("script") && !document.querySelector("[onerror]") && document.querySelector("img[src^=https]")?.naturalWidth===0;')));
  writeFileSync(ctx.report.path("29-epub-assets.json"), JSON.stringify(await wd.execute('return {base:document.baseURI,color:getComputedStyle(document.body).color,images:[...document.images].map(i=>({src:i.src,html:i.outerHTML,width:i.naturalWidth,complete:i.complete})),csp:document.querySelector("meta[http-equiv]")?.content,scripts:document.querySelectorAll("script").length,onerror:document.querySelectorAll("[onerror]").length,intrusion:window.__epubIntrusion||null};'), null, 2));
  await office();
  await wd.execute('window.__epubCspProbe=0;const doc=document.querySelector("iframe.epub-frame").contentDocument;const script=doc.createElement("script");script.textContent="parent.__epubCspProbe=1";doc.body.append(script);const button=doc.createElement("button");button.id="csp-probe";button.textContent="CSP probe";button.setAttribute("onclick","parent.__epubCspProbe=2");doc.body.append(button);');
  await chapter("#csp-probe"); await wd.click(await wd.waitFor("#csp-probe")); await office();
  ctx.report.check(S, "정리 후 삽입한 스크립트·인라인 핸들러도 CSP가 거절", await wd.execute<boolean>('const doc=document.querySelector("iframe.epub-frame").contentDocument;return window.__epubCspProbe===0 && doc.querySelector("meta[http-equiv]").content.includes("script-src \'none\'");'));
  await save(); ctx.report.check(S, "편집 전 저장은 원본 바이트 일치", readFileSync(file).equals(original));
  await edit("되돌릴 문장");
  if (!await until(async () => wd.execute<boolean>('return document.querySelector("[data-action=undo]")?.disabled===false;'))) {
    writeFileSync(ctx.report.path("29-epub-input-late.json"), JSON.stringify(await wd.execute('return {events:window.__epubEvents,calls:window.__epubCalls,body:document.body.textContent};'), null, 2));
    throw new Error("EPUB undo was not enabled");
  }
  await wd.click(await wd.waitFor('[data-action="undo"]')); await save();
  ctx.report.check(S, "원본 Undo 뒤 저장은 원본 바이트 일치", readFileSync(file).equals(original));
  await edit("한글로 고친 첫 문단"); await save();
  const saved = await content(); writeFileSync(ctx.report.path("29-epub-saved.xhtml"), saved);
  ctx.report.check(S, "실제 문단 입력·원본 범위 저장", saved.includes('<p id="p1">한글로 고친 첫 문단</p>') && saved.startsWith("\ufeff") && saved.includes("\r\n"));
  ctx.report.check(S, "다른 장·모르는 부속 파일 보존", (await epubEntry(readFileSync(file), "OEBPS/text/two.xhtml"))!.toString() === EPUB_SECOND && (await epubEntry(readFileSync(file), "future/unknown.bin"))!.equals((await epubEntry(original, "future/unknown.bin"))!));
  await chapter(); await wd.click(await wd.waitFor('a[href="two.xhtml#chapter2"]')); await chapter("#chapter2");
  ctx.report.check(S, "책 안 링크로 다른 장 열기", await wd.execute<boolean>('return document.body.textContent.includes("Second chapter text stays.");'));
  await wd.click(await wd.waitFor('a[href="one.xhtml#p1"]')); await chapter();
  ctx.report.check(S, "첫 장으로 돌아와 저장한 글 유지", await wd.execute<boolean>('return document.querySelector("#p1")?.textContent==="한글로 고친 첫 문단";'));
  await office(); await wd.click(await wd.waitFor('[data-tab="view"]')); await wd.click(await wd.waitFor('[data-action="dark-view"]'));
  await wd.frame(null); await clickText('.doc-header [role="radio"]', "글 보기");
  ctx.report.check(S, "글 보기에서 원본 엔진 텍스트 제공", await until(async () => wd.execute<boolean>('return !document.querySelector("iframe.office-frame") && document.querySelector(".cm-content")?.textContent.includes("한글로 고친 첫 문단");'), 15000));
  await clickText('.doc-header [role="radio"]', "편집"); await office(); await installProbe(wd);
  const reading = await wd.execute<{ dark: boolean }>('return window.epubApi.getReadingState().then(s=>({dark:s.viewPrefs.dark}));');
  ctx.report.check(S, "새 편집기에서 읽기 설정 재열기", reading.dark === true);
  await edit("충돌 뒤 되살릴 문단");
  const external = await epubFixture("EXTERNAL BOOK"); writeFileSync(file, external); await api("POST", `/api/artifacts/${artifact.id}/adopt-disk`);
  await save(); await wd.frame(null); await wd.waitFor(".doc-conflict", 15000);
  ctx.report.check(S, "외부 변경 충돌 시 원본 파일 보존", readFileSync(file).equals(external));
  await wd.refresh(); await installProbe(wd); await chapter();
  ctx.report.check(S, "새로고침 뒤 실제 전자책 복구본 재열기", await wd.execute<boolean>('return document.querySelector("#p1")?.textContent==="충돌 뒤 되살릴 문단";') && readFileSync(file).equals(external));
  await wd.frame(null); await clickText(".doc-conflict button", "내 편집을 새 판으로");
  ctx.report.check(S, "복구본 전체를 새 판으로 저장", await until(async () => (await content()).includes('<p id="p1">충돌 뒤 되살릴 문단</p>'), 20000));
  ctx.report.check(S, "외부 판과 새 판 이력 보존", (await snapshot()).artifacts.find((a) => a.id === artifact.id)!.revision >= 4);
  await edit("긴급 복구할 입력 문단"); const beforeKeep = readFileSync(file); await wd.frame(null);
  await wd.execute('window.__epubKept=false; window.addEventListener("message",event=>{if(event.data?.type==="office:flushed")window.__epubKept=true;}); const frame=document.querySelector("iframe.office-frame"); frame.contentWindow.postMessage({type:"office:keep"},new URL(frame.src).origin);');
  const kept = await until(async () => wd.execute<boolean>("return window.__epubKept===true"), 20000);
  ctx.report.check(S, "긴급 보관은 원본을 쓰지 않음", kept && readFileSync(file).equals(beforeKeep));
  await wd.refresh(); await installProbe(wd); await chapter();
  ctx.report.check(S, "긴급 보관이 입력 중인 문단도 복원", await wd.execute<boolean>('return document.querySelector("#p1")?.textContent==="긴급 복구할 입력 문단";'));
  await save(); ctx.report.check(S, "되살린 문단을 정상 저장", (await content()).includes('<p id="p1">긴급 복구할 입력 문단</p>'));
  const errors = await pageErrors(wd); await wd.frame(null);
  ctx.report.check(S, "전자책 편집기·상위 앱 예외 없음", !errors.length && !(await pageErrors(wd)).length, errors.join("\n") || undefined, await shot(ctx, "29-epub-recovered.png"));
}
