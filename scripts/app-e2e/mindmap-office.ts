import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, Snapshot, Work } from "@workbench/contracts";
import { mindmapFixture, readMindmapFixture } from "./mindmap-fixture.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

export async function mindmapOfficeScenario(ctx: Ctx) {
  const S = "28 마인드맵 원본 편집기", { wd, api } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "마인드맵 이음 편집 검사", cwd: null });
  const file = join(work.cwd, "원본 보존 지도.xmind"), original = await mindmapFixture(); writeFileSync(file, original);
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const tab = { id: "map-tab", workId: work.id, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "edit" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "map-pane", panes: [{ ...tab, id: "map-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
  const enter = async () => { await wd.frame(await wd.waitFor("iframe.office-frame", 30000)); await installProbe(wd); await wd.waitFor(".mm-sheet-host:not([hidden]) me-root me-tpc", 30000); };
  await enter();
  const shortcut = (value: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value }, { type: "keyUp", value }, { type: "keyUp", value: KEY.control }]);
  // Resolve each topic afresh: undo and sheet selection can replace the DOM.
  const topic = (id: string) => wd.waitFor(`.mm-sheet-host:not([hidden]) me-tpc[data-nodeid="me${id}"]`);
  const editRoot = async (text: string) => {
    await wd.click(await topic("root-1")); await wd.press("\uE032");
    const field = await wd.waitFor("#input-box");
    if (!await until(async () => wd.execute<boolean>('return document.activeElement?.id==="input-box" && window.getSelection()?.toString()===document.querySelector("#input-box")?.textContent;'))) throw new Error(`Title focus/selection failed: ${await wd.execute<string>('return JSON.stringify({active:document.activeElement?.outerHTML?.slice(0,200),selection:window.getSelection()?.toString()})')}`);
    await shortcut("a"); await wd.press("\uE003"); await wd.sendKeys(field, text); await wd.press(KEY.enter);
    if (!await until(async () => !(await wd.find("#input-box")))) throw new Error("Map title edit did not finish");
  };
  const save = async () => {
    await wd.execute('window.__mapSaveDone=false; const api=window.mindmapApi; if(!api.__observedSave){const save=api.save;api.save=async(...args)=>{try{return await save(...args);}finally{window.__mapSaveDone=true;}};api.__observedSave=true;}');
    await shortcut("s");
    if (!await until(async () => wd.execute<boolean>("return window.__mapSaveDone===true"), 20000)) throw new Error("Map save did not settle");
  };
  const clickText = async (selector: string, label: string) => {
    if (!await until(async () => {
      for (const button of await wd.findAll(selector)) if ((await wd.execute<string>("return arguments[0].textContent.trim()", button)) === label && await wd.displayed(button)) { await wd.click(button); return true; }
      return false;
    }, 15000)) throw new Error(`Missing map command: ${label}`);
  };
  ctx.report.check(S, "원본 지도·보존 요소 안내를 Electron 없이 열기", await wd.execute<boolean>('return document.body.textContent.includes("Native map") && document.body.textContent.includes("보이지 않는 요소");'), undefined, await shot(ctx, "28-map-open.png"));
  ctx.report.check(S, "파일 안 그림만 표시·HTML 모양 글자는 글자로 유지", await until(async () => wd.execute<boolean>('return [...document.querySelectorAll(".map-container img")].some(img=>img.src.startsWith("blob:") && img.naturalWidth>0) && !document.querySelector(".map-container img[src=x]");')));
  await save(); ctx.report.check(S, "편집 전 저장은 원본 바이트 일치", readFileSync(file).equals(original));
  await editRoot("되돌릴 제목"); await wd.click(await wd.waitFor('[data-action="undo"]'));
  await save(); ctx.report.check(S, "편집을 되돌린 뒤 저장도 원본 바이트 일치", readFileSync(file).equals(original));
  await editRoot("한글로 고친 지도");
  await wd.click(await topic("root-1")); await wd.click(await wd.waitFor('[data-action="add-child"]'));
  await wd.sendKeys(await wd.waitFor("#input-box"), "추가한 가지"); await wd.press(KEY.enter);
  await wd.click(await topic("child-1")); await wd.click(await wd.waitFor('[data-action="note"]'));
  await wd.sendKeys(await wd.waitFor('[data-action="note-field"]'), " 저장 시 반영할 메모"); await save();
  let parsed = await readMindmapFixture(readFileSync(file));
  writeFileSync(ctx.report.path("28-map-saved.json"), JSON.stringify(parsed.sheets, null, 2));
  ctx.report.check(S, "토픽·가지·입력 중인 메모를 원본 편집기로 저장", parsed.sheets[0].rootTopic.title === "한글로 고친 지도" && parsed.sheets[0].rootTopic.children.attached.some((t: { title: string }) => t.title === "추가한 가지") && parsed.sheets[0].rootTopic.children.attached[0].notes.plain.content.includes("저장 시 반영할 메모"));
  const originalMap = await readMindmapFixture(original);
  ctx.report.check(S, "모르는 키·떠 있는 토픽·원본 부속 파일 보존", parsed.sheets[0].futureSheetKey.keep === true && parsed.sheets[0].rootTopic.futureTopicKey[1] === "preserve" && parsed.sheets[0].rootTopic.children.detached[0].future === "kept" && (await parsed.entry("future/custom.bin"))!.equals((await originalMap.entry("future/custom.bin"))!) && (await parsed.entry("metadata.json"))!.equals((await originalMap.entry("metadata.json"))!));
  await wd.click(await wd.waitFor('[data-action="theme"]')); await wd.click(await wd.waitFor('[data-theme-pick="skeleton:line"]')); await wd.click(await wd.waitFor('[data-theme-pick="band:harbor"]'));
  await save(); parsed = await readMindmapFixture(readFileSync(file));
  ctx.report.check(S, "원본 테마 선택을 문서에 저장", Boolean(parsed.sheets[0].theme), undefined, await shot(ctx, "28-map-theme.png"));
  await wd.click(await wd.waitFor(".mm-sheet-add")); await save();
  ctx.report.check(S, "시트 추가 저장", (await readMindmapFixture(readFileSync(file))).sheets.length === 2);
  await wd.click(await wd.waitFor('.mm-sheet:first-child .mm-sheet-name'));
  const firstErrors = await pageErrors(wd); await wd.frame(null);
  await clickText('.doc-header [role="radio"]', "글 보기");
  ctx.report.check(S, "글 보기에서 원본 엔진의 개요 제공", await until(async () => wd.execute<boolean>('return !document.querySelector("iframe.office-frame") && document.querySelector(".cm-content")?.textContent.includes("한글로 고친 지도");'), 15000));
  await clickText('.doc-header [role="radio"]', "편집"); await enter();
  ctx.report.check(S, "새 편집기에서 제목·테마·시트 재열기", await wd.execute<boolean>('return document.body.textContent.includes("한글로 고친 지도") && document.querySelectorAll(".mm-sheet").length===2;'));
  await editRoot("충돌 후 복구할 지도");
  const external = await mindmapFixture("EXTERNAL MAP"); writeFileSync(file, external); await api("POST", `/api/artifacts/${artifact.id}/adopt-disk`);
  await save(); await wd.frame(null); await wd.waitFor(".doc-conflict", 15000);
  ctx.report.check(S, "충돌 저장 거절·외부 파일 보존", readFileSync(file).equals(external));
  await wd.refresh(); await installProbe(wd); await enter();
  ctx.report.check(S, "새로고침 뒤 실제 마인드맵 복구본 재열기", await wd.execute<boolean>('return document.body.textContent.includes("충돌 후 복구할 지도") && document.querySelectorAll(".mm-sheet").length===2;') && readFileSync(file).equals(external));
  await wd.frame(null); await clickText(".doc-conflict button", "내 편집을 새 판으로");
  ctx.report.check(S, "명시적 충돌 해결 후 복구본 전체를 새 판으로 저장", await until(async () => { const doc = await readMindmapFixture(readFileSync(file)); return doc.sheets.length === 2 && doc.sheets[0].rootTopic.title === "충돌 후 복구할 지도"; }, 20000));
  ctx.report.check(S, "저장과 충돌 해결을 문서 판 이력으로 기록", (await snapshot()).artifacts.find((a) => a.id === artifact.id)!.revision >= 6);
  await enter();
  await wd.click(await topic("child-1")); await wd.click(await wd.waitFor('[data-action="note"]'));
  await wd.sendKeys(await wd.waitFor('[data-action="note-field"]'), " 복구할 미확정 메모");
  const beforeKeep = readFileSync(file);
  await wd.frame(null);
  await wd.execute('window.__mapKept=false; window.addEventListener("message",event=>{if(event.data?.type==="office:flushed")window.__mapKept=true;}); const frame=document.querySelector("iframe.office-frame"); frame.contentWindow.postMessage({type:"office:keep"},new URL(frame.src).origin);');
  const kept = await until(async () => wd.execute<boolean>("return window.__mapKept===true"), 20000);
  ctx.report.check(S, "입력 중인 메모 복구본은 원본 파일을 바꾸지 않음", kept && readFileSync(file).equals(beforeKeep));
  await wd.refresh(); await installProbe(wd); await enter();
  await wd.click(await topic("child-1"));
  if (!await wd.find('[data-action="note-field"]')) await wd.click(await wd.waitFor('[data-action="note"]'));
  ctx.report.check(S, "긴급 복구가 아직 입력 중인 메모까지 보관", await until(async () => wd.execute<boolean>('return document.querySelector("[data-action=note-field]")?.value.includes("복구할 미확정 메모");')));
  await save();
  ctx.report.check(S, "되살린 메모를 정상 저장", (await readMindmapFixture(readFileSync(file))).sheets[0].rootTopic.children.attached[0].notes.plain.content.includes("복구할 미확정 메모"));
  const lastErrors = await pageErrors(wd); await wd.frame(null);
  ctx.report.check(S, "마인드맵 편집기·상위 앱 예외 없음", !firstErrors.length && !lastErrors.length && !(await pageErrors(wd)).length, [...firstErrors, ...lastErrors].join("\n") || undefined, await shot(ctx, "28-map-recovered.png"));
}
